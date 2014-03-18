'use strict';

var path = require('path');
var util = require('util');
var mkdirp = require('mkdirp');
var request = require('request');
//var handlers = require('./module/handlers');
var stream = require('stream');
var tls = require('tls');
var net = require('net');
var fs = require('fs');

var mqtt = require('mqtt');
var mqttrouter = require('mqtt-router');

function CloudConnection(opts, creds, app) {

  if (!opts || Object.keys(opts).length === 0) {
    app.log.error('Invalid opts object provided');
    return false;
  }

  /*
  if (!creds || typeof creds !== 'function') {

    app.log.error('Invalid credential provider specified');
    return false;
  }
  */

  this.app = app;
  this.opts = opts || undefined;
  this.creds = creds;
  this.sendBuffer = [];
  this.modules = {};
  this.devices = {};
  this.log = app.log.extend('CloudConnection');

  //creds.call(this, opts);

  // versioning.call(this, opts);

  //this.node = undefined; // upnode
  this.transport = opts.secure ? tls : net;

  //this.versionClient();
}

util.inherits(CloudConnection, stream);

//handlers(Client);

/**
 * Connect the block to the cloud
 */
CloudConnection.prototype.connect = function connect() {
  this.log.debug('connect called.');

  var self = this;
  this.node = {};

  // if the system doesn't have a token yet we need to park
  // and wait for registration
  if (!this.creds.token) {

    this.app.emit('client::activation', true);
    this.log.info('Attempting to activate...');

    this.activate(function activate(err, res) {
      if (err) {
        this.log.error('Failed activation', err);
        process.nextTick(process.exit);
        return;
      }
      this.mqttId = res.mqttId;
      this.creds.token = res.token;
      this.creds.saveToken(function() {
        self.log.info('Exiting now.');
        process.nextTick(process.exit);
      });
    }.bind(this));

  } else {

    this.log.info('Token found. Connecting...');

    var mqttOpts = {
      username: this.creds.token,
      keepalive: 30,
      qos: 1,
      clientId: this.creds.serial,
      retain: true
    };

    // todo we need to cater for encrypted and unencrypted connections based on environment.
    this.mqttclient = mqtt.createSecureClient(8883, this.opts.cloudHost, mqttOpts);

    this.mqttclient.on('close', this.down.bind(this));
    this.mqttclient.on('connect', this.up.bind(this));

    this.initialize();
  }

  // enable the subscription router
  this.router = mqttrouter.wrap(this.mqttclient);

};

CloudConnection.prototype.activate = function(cb) {

  this.log.info('attempting activation for serial', this.creds.serial);

  var url = this.opts.secure ? 'https://' + this.opts.apiHost + ':' + this.opts.apiPort : 'http://' + this.opts.apiHost + ':' + this.opts.apiPort;

  request.get(url + '/rest/v0/block/' + this.creds.serial + '/activate', function getToken(error, response, body) {
    if (error) return cb(error);

    if (response.statusCode == 200) {
      if (body) {
        return cb(null, JSON.parse(body));
      } else {
        return cb(new Error('Timed out waiting for activation'));
      }
    } else {
      return cb(new Error('Unable to activate response code = ' + response.statusCode));
    }
  });

};

CloudConnection.prototype.subscribe = function() {

  var self = this;

  this.router.subscribe('$block/' + this.creds.serial + '/revoke', function revokeCredentials() {
    self.log.info('MQTT Invalid token; exiting in 3 seconds...');
    self.app.emit('client::invalidToken', true);
    setTimeout(function invalidTokenExit() {

      self.log.info('Exiting now.');
      process.exit(1);

    }, 3000);
  });

  this.router.subscribe('$block/' + this.creds.serial + '/commands', {
    qos: 1
  }, function execute(topic, cmd) {
    self.log.info('MQTT readExecute', JSON.parse(cmd));
    self.command(cmd);
  });

  this.router.subscribe('$block/' + this.creds.serial + '/update', {
    qos: 1
  }, function update(topic, cmd) {
    self.log.info('MQTT readUpdate', JSON.parse(cmd));
    self.updateHandler(cmd);
  });

  this.router.subscribe('$block/' + this.creds.serial + '/config', {
    qos: 1
  }, function update(topic, cmd) {
    self.log.info('MQTT readConfig', cmd);
    self.moduleHandlers.config.call(self, JSON.parse(cmd));
  });


  // TODO install and update handlers
};

/**
 * Initialize the session with the cloud after a connection
 * has been established.
 */
CloudConnection.prototype.initialize = function initialize() {

  var self = this;

  var flushBuffer = function flushBuffer() {

    if (!this.sendBuffer) {
      this.sendBuffer = [];
      return;
    }
    if (this.sendBuffer.length > 0) {

      self.log.info('Sending buffered commands...');

      var blockId = this.creds.serial;
      var topic = ['$cloud', blockId, 'data'].join('/');

      console.log('sendData', 'flushBuffer', 'mqtt', topic);

      self.sendMQTTMessage(topic, {
        'DEVICE': this.sendBuffer
      });

      this.sendBuffer = [];
    } else {

      this.log.debug('No buffered commands to send');
    }
  };

  var initSession = function initSession(cloud) {

    self.cloud = cloud;

    flushBuffer.call(self);
  };

  var beat = function beat() {

    // this.log.debug('Sending heartbeat');
    self.cloud.heartbeat(JSON.stringify({
      'TIMESTAMP': (new Date().getTime()),
      'DEVICE': []
    }));
  };

  this.app.on('client::preup', initSession);
};

/**
 * cloud event handlers
 */
CloudConnection.prototype.up = function up(cloud) {

  try {
    this.app.emit('client::preup', cloud);
    this.app.emit('client::up', cloud);
  } catch (err) {

    this.log.error('An unknown module had the following error:\n\n%s\n', err.stack);
  }

  this.log.info('Client connected to the Ninja Platform');

  // if we have credentials
  if (this.creds.token) {

    // clear out the existing handlers
    this.router.reset();

    // subscribe to all the cloud topics
    this.subscribe();

  }
};

CloudConnection.prototype.down = function down() {

  this.app.emit('client::down', true);
  this.log.warn('Client disconnected from the Ninja Platform');

};

CloudConnection.prototype.reconnect = function reconnect() {

  this.app.emit('client::reconnecting', true);

  this.log.info('Connecting to cloud...');
};

/**
 * Generate scoped parameters for dnode connection
 */
CloudConnection.prototype.getParameters = function getParameters(opts) {

  var cloudPort = this.opts.cloudPort;
  var cloudHost = this.opts.cloudHost;
  var transport = this.transport;

  return {

    ping: 10000,
    timeout: 5000,
    reconnect: 2000,
    createStream: function createStream() {

      return transport.connect(cloudPort, cloudHost);
    },
    block: this.block.bind(this)
  };
};

CloudConnection.prototype.dataHandler = function dataHandler(device) {

  var self = this;
  return function(data) {

    try {

      self.sendData({

        G: device.G.toString(),
        V: device.V,
        D: device.D,
        DA: data
      });
    } catch (e) {

      self.log.debug('Error sending data (%s)', self.getGuid(device));
      self.log.error(e);
    }
  };
};

CloudConnection.prototype.heartbeatHandler = function dataHandler(device) {

  var self = this;
  return function(hb) {

    try {

      var heartbeat = hb || {};
      heartbeat.G = device.G.toString();
      heartbeat.V = device.V;
      heartbeat.D = device.D;

      if (typeof device.name === 'string') {
        heartbeat.name = device.name;
      }

      self.sendHeartbeat(heartbeat);
    } catch (e) {

      self.log.debug('Error sending heartbeat (%s)', self.getGuid(device));
      self.log.error(e);
    }
  };
};

CloudConnection.prototype.sendData = function sendData(dat) {

  if (!dat) {
    return false;
  }

  dat.TIMESTAMP = (new Date().getTime());
  var msg = {
    'DEVICE': [dat]
  };

  if ((this.mqttclient)) { //  && this.cloud.data) {

    var blockId = this.creds.serial;
    var deviceId = [dat.G, dat.V, dat.D].join('_');
    var topic = ['$cloud', blockId, 'devices', deviceId, 'data'].join('/');

    this.log.debug('sendData', 'mqtt', topic);
    this.sendMQTTMessage(topic, msg);
  }

  this.bufferData(msg);
};

CloudConnection.prototype.sendConfig = function sendConfig(dat) {

  if (!dat) {
    return false;
  }

  dat.TIMESTAMP = (new Date().getTime());
  if ((this.cloud) && this.cloud.config) {

    var blockId = this.creds.serial;
    var deviceId = [dat.G, dat.V, dat.D].join('_');
    var topic = ['$cloud', blockId, 'devices', deviceId, 'config'].join('/');
    this.log.debug('sendConfig', 'mqtt', topic);

    this.sendMQTTMessage(topic, dat);
  }
};

CloudConnection.prototype.sendHeartbeat = function sendHeartbeat(dat) {

  if (!dat) {
    return false;
  }

  dat.TIMESTAMP = (new Date().getTime());
  var msg = {
    'DEVICE': [dat]
  };

  if (this.mqttclient) {

    var blockId = this.creds.serial;
    var deviceId = [dat.G, dat.V, dat.D].join('_');
    var topic = ['$cloud', blockId, 'devices', deviceId, 'heartbeat'].join('/');
    this.log.debug('sendHeartbeat', 'mqtt', topic);

    this.sendMQTTMessage(topic, dat);
  }
};

CloudConnection.prototype.sendMQTTMessage = function sendMQTTMessage(topic, msg) {

  // add the token to the message as this is currently the only way to identify a unique instance of a
  // block
  msg._token = this.creds.token;

  this.mqttclient.publish(topic, JSON.stringify(msg));
};

CloudConnection.prototype.bufferData = function bufferData(msg) {

  this.sendBuffer.push(msg);

  if (this.sendBuffer.length > 9) {

    this.sendBuffer.shift();
  }
};

CloudConnection.prototype.command = function command(dat) {

  var data = this.getJSON(dat);

  for (var d = 0, ds = data.DEVICE; d < ds.length; d++) {

    // console.log('Executing: ');
    // console.log(ds[d]);

    var guid = ds[d].GUID;
    var device;
    // delete ds[d].GUID;

    ds[d].G = ds[d].G.toString();

    if ((device = this.devices[guid]) && typeof device.write == 'function') {

      try {

        this.devices[guid].write(ds[d].DA);
        return true;
      } catch (e) {
        this.log.error('error actuating: %s (%s)', guid, e.message);
      }
    } else {

      // most likely an arduino device (or a bad module)
      this.log.debug('actuating %s (%s)', guid, ds[d].DA);
      this.app.emit('device::command', ds[d]);
    }
  }
};

CloudConnection.prototype.getGuid = function getGuid(device) {

  return [
    this.creds.serial, device.G, device.V, device.D
  ].join('_');
};

CloudConnection.prototype.getJSON = function getJSON(dat) {

  try {
    if (dat instanceof Buffer) {
      dat = dat.toString();
    }
    return JSON.parse(dat);
  } catch (e) {

    this.log.debug('Invalid JSON: %s', e);
    return false;
  }
};

module.exports = CloudConnection;