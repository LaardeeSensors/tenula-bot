'use strict';

const fetch = require('node-fetch');
const moment = require('moment');
const _ = require('lodash');
const { decrypt } = require('../shared/secrets');
const log = require('../shared/log');
const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: AWS.config.region || process.env.SERVERLESS_REGION || 'us-east-1',
});

const lambda = new AWS.Lambda({
  region: AWS.config.region || process.env.SERVERLESS_REGION || 'us-east-1',
});

const insertAuthenticationToken = ({ access_token: token }) => {
  const Item = Object.assign({ created: Date.now(), id: 'token', token });
  const params =
    Object.assign(
      { TableName: process.env.AUTHENTICATION_TABLE_NAME },
      { Item });
  return dynamodb
    .put(params).promise()
    .then(() => ({ token }));
};

const getAuthenticationToken = () => {
  const params = {
    TableName: process.env.AUTHENTICATION_TABLE_NAME,
    KeyConditionExpression: '#id = :token',
    ExpressionAttributeNames: {
      '#id': 'id',
    },
    ExpressionAttributeValues: {
      ':token': 'token',
    },
  };

  return dynamodb.query(params).promise()
    .then(({ Items }) => {
      const { token } = Items[0];
      return { token };
    })
    .catch(() => ({ token: '' }));
};

const authenticate = (expired) => {
  if (expired === true) {
    return decrypt([process.env.MS_BOT_CLIENT_ID, process.env.MS_BOT_CLIENT_SECRET])
      .then(([clientId, clientSecret]) => {
        const params = {
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://api.botframework.com/.default',
        };

        const searchParams = Object.keys(params).map((key) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`).join('&');

        return fetch('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token',
          { method: 'POST',
            body: searchParams,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          });
      }).then(res => res.json())
      .then(insertAuthenticationToken);
  }

  return getAuthenticationToken();
};

const sendReply = ({ serviceUrl, token, payload }) => {
  if (payload.text) {
    const url = `${serviceUrl}/v3/conversations/${payload.conversation.id}/activities/${payload.replyToId}`; // eslint-disable-line max-len
    return fetch(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': JSON.stringify(payload).length,
      },
    });
  }

  return Promise.resolve(null);
};

const getCurrent = (location) =>
  fetch(`${process.env.SENSORS_API}/locations/${location}/latest`)
    .then(res => res.json());

const route = (message) => {
  const query =
    message.channelId === 'telegram' &&
    message.channelData.inline_query &&
    message.channelData.inline_query.query
      ? message.channelData.inline_query.query.replace('-', '/')
      : '';

  const text = message.text || query;
  if (/^\/current.*/.test(text)) {
    return getCurrent('tenula')
      .then(devices => devices.map((device) => {
        const time = moment(device.timestamp).utcOffset(3).calendar();
        const temperature = _.find(device.sensors, { type: 'temperature' });
        const absolutePressure = _.find(device.sensors, { type: 'absolutePressure' });
        const seaLevelPressure = _.find(device.sensors, { type: 'seaLevelPressure' });
        // @todo templates
        return `**${device.name} ${time}**\n\nTemp: ${Math.round(temperature.value * 100) / 100}°C\n\nAbs. pressure: ${Math.round(absolutePressure.value * 100) / 100} hPa\n\nSea level pressure: ${Math.round(seaLevelPressure.value * 100) / 100} hPa`;
      }).join('\n\n---\n\n'));
  } else if (/^\/sensors.*/.test(text)) {
    return Promise.resolve(String.fromCodePoint(128528));
  }
  return Promise.resolve('/current for latest sensor readings');
};

module.exports.handler = (event, context, callback) => {
  log(event, context);
  const message = JSON.parse(event.body);
  const response = {
    statusCode: 200,
    body: JSON.stringify({
      message: 'ok',
      input: event,
    }),
  };

  const replyPayload = {
    type: 'message',
    from: {
      id: message.recipient.id,
      name: message.recipient.name,
    },
    conversation: {
      isGroup: message.conversation.isGroup,
      id: message.conversation.id,
    },
    recipient: {
      id: message.from.id,
      name: message.from.name,
    },
    text: '',
    replyToId: message.id,
  };

  return authenticate(event.expired)
    .then(({ token }) =>
      route(message)
        .then(data => ({
          serviceUrl: message.serviceUrl,
          token,
          payload: Object.assign({}, replyPayload, { text: data }),
        })))
    .then(sendReply)
    .then(res => {
      log('sendReply status', res.status);
      if (res.status !== 200 && !event.expired) {
        return lambda.invoke({
          FunctionName: context.functionName,
          InvocationType: 'Event',
          Payload: JSON.stringify(Object.assign({ expired: true }, event)),
        }).promise();
      }

      return Promise.resolve();
    })
    .then(() => callback(null, response))
    .catch(error =>
      log(error)
        .then(() => callback(null, response)));
};
