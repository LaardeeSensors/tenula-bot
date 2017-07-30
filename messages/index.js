'use strict';

const fetch = require('node-fetch');
const moment = require('moment');
const _ = require('lodash');
const { decrypt } = require('../shared/secrets');
const log = require('../shared/log');

const authenticate = () =>
  decrypt([process.env.MS_BOT_CLIENT_ID, process.env.MS_BOT_CLIENT_SECRET])
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
    }).then(res => res.json());

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

  return Promise.resolve('');
};

const getCurrent = (deviceId) =>
  fetch(`${process.env.SENSORS_API}/data/${deviceId}/current`)
    .then(res => res.json());

const route = (message) => {
  if (/^\/current.*/.test(message.text)) {
    return Promise.all([
      getCurrent('b764034949e0c8643f09689666669b8c'),
      getCurrent('b8f82803b0d69415ef92a36519fb1d81'),
    ]).then(devices => devices.map((device) => {
      const time = moment(device.timestamp).calendar();
      const temperature = _.find(device.sensors, { type: 'temperature' });
      const absolutePressure = _.find(device.sensors, { type: 'absolutepressure' });
      const seaLevelPressure = _.find(device.sensors, { type: 'seaLevelPressure' });
      // @todo templates
      return `**${device.name} ${time}**\n\nTemp: ${Math.round(temperature.value * 100) / 100}°C\n\nAbs. pressure: ${Math.round(absolutePressure.value * 100) / 100} hPa\n\nSea level pressure: ${Math.round(seaLevelPressure.value * 100) / 100} hPa`;
    }).join('\n\n---\n\n'));
  } else if (/^\/sensors.*/.test(message.text)) {
    return Promise.resolve(String.fromCodePoint(128528));
  }
  return Promise.resolve(null);
};

module.exports.handler = (event, context, callback) => {
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
  return authenticate()
    .then(({ access_token: token }) =>
      route(message)
        .then(data => ({
          serviceUrl: message.serviceUrl,
          token,
          payload: Object.assign({}, replyPayload, { text: data }),
        })))
    .then(sendReply)
    .then(() => callback(null, response))
    .catch(error =>
      log(error)
        .then(() => callback(null, response)));
};
