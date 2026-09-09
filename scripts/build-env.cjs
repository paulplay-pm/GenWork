'use strict';

// Environment variable names shared by the channel build entry points
// (dist-win-channel.cjs, dist-win-web.cjs) and electron-builder-config.cjs.

const BuildEnv = {
  Keyfrom: 'KEYFROM',
  WebInstaller: 'GENWORK_WEB_INSTALLER',
  WebPkgUrl: 'GENWORK_WEB_PKG_URL',
  WebPkgBaseUrl: 'GENWORK_WEB_PKG_BASE_URL',
};

// Every variable a channel build must control itself; the build entry points
// scrub these from the inherited shell environment so leftovers from earlier
// commands can never leak into a build.
const CHANNEL_SCOPED_ENV_VARS = Object.values(BuildEnv);

module.exports = {
  BuildEnv,
  CHANNEL_SCOPED_ENV_VARS,
};
