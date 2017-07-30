'use strict';

module.exports = (...data) => {
  console.log(JSON.stringify(data, null, 2));
  return Promise.resolve(...data);
};
