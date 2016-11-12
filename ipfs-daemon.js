'use strict'

const fs = require('fs')
const mkdirp = require('mkdirp')
const path = require('path')
const ipfsd = require('ipfsd-ctl')
const IpfsApi = require('ipfs-api') // go-ipfs
// const IPFS = require('ipfs') // TODO: js-ipfs
const EventEmitter = require('events').EventEmitter
const Logger = require('logplease')
const logger = Logger.create("ipfs-daemon")

Logger.setLogLevel(process.env.LOG ? process.env.LOG.toUpperCase() : 'ERROR')

const defaultOptions = {
  // Location of IPFS repository
  IpfsDataDir: process.env.IPFS_PATH || './ipfs',
  // Location to write log files to
  LogDirectory: '/tmp',
  // Bind the IPFS daemon to a random port by default
  Addresses: {
    API: '/ip4/127.0.0.1/tcp/5001',
    Swarm: ['/ip4/0.0.0.0/tcp/4001'],
    Gateway: '/ip4/0.0.0.0/tcp/8080'
  },
  // Flags to pass to the IPFS daemon
  Flags: ['--enable-pubsub-experiment'] // Enable Pubsub by default
}

class IpfsDaemon extends EventEmitter {
  constructor(options) {
    super()

    this.GatewayAddress = null
    this.APIAddress = null

    let opts = Object.assign({}, defaultOptions)
    Object.assign(opts, options)
    this._options = opts

    // Daemon that gets returned by ipfsd-ctl
    this._daemon = null

    // Make sure we have the app data directory
    if (!fs.existsSync(this._options.IpfsDataDir))
      mkdirp.sync(this._options.IpfsDataDir)

    // Setup logfiles
    Logger.setLogfile(path.join(this._options.LogDirectory, '/ipfs-daemon.log'))

    // Handle shutdown signals
    process.on('SIGINT', () => this._handleShutdown)
    process.on('SIGTERM', () => this._handleShutdown)

    // Log errors
    process.on('uncaughtException', (error) => {
      // Skip 'ctrl-c' error and shutdown gracefully
      const match = String(error).match(/non-zero exit code 255/)
      if(match)
        this._handleShutdown()
      else
        logger.error(error)
    })

    // Initialize and start the daemon
    this._initDaemon()
      .then((daemon) => this._startDaemon(daemon))
      .then(() => this.emit('ready'))
      .catch((e) => this.emit('error', e))
  }

  stop() {
    this._handleShutdown()
  }

  _initDaemon() {
    return new Promise((resolve, reject) => {
      ipfsd.local(this._options.IpfsDataDir, this._options, (err, node) => {
        if(err) 
          reject(err)

        this._daemon = node

        logger.debug("Initializing IPFS daemon")
        logger.debug(`Using IPFS repo at '${node.path}'`)

        this._daemon.init({ directory: this._options.IpfsDataDir }, (err, node) => {
          if (err) {
            // Check if the IPFS repo is an incompatible one
            const migrationNeeded = String(err).match('ipfs repo needs migration')

            if (migrationNeeded) {
              let errStr = `Error initializing IPFS daemon: '${migrationNeeded[0]}'\n`
              errStr += `Tried to init IPFS repo at '${opts.IpfsDataDir}', but failed.\n`
              errStr += `Use $IPFS_PATH to specify another repo path, eg. 'export IPFS_PATH=/tmp/orbit-floodsub'.`

              errStr.split('\n').forEach((e) => logger.error(e))

              reject(errStr)
            } 
          } else {
            resolve()
          }
        })
      })
    })
  }

  _startDaemon() {
    return new Promise((resolve, reject) => {
      logger.debug("Starting IPFS daemon")
      this._daemon.startDaemon(this._options.Flags, (err, ipfs) => {
        if (err)
          return reject(err)

        if (this._daemon.gatewayAddr)
          this.GatewayAddress = this._daemon.gatewayAddr + '/ipfs/'
        // this.GatewayAddress = this._daemon.gatewayAddr ? this._daemon.gatewayAddr + '/ipfs/' : 'localhost:8080/ipfs/'

        Object.assign(this, IpfsApi(ipfs.apiHost, ipfs.apiPort))
        this.APIAddress = ipfs.apiHost + ':' + ipfs.apiPort

        logger.debug("IPFS daemon started at", this.APIAddress)
        logger.debug("Gateway listening at", this.GatewayAddress)

        resolve(ipfs)
      })      
    })
  }

  // Handle shutdown gracefully
  _handleShutdown() {
    logger.debug("Shutting down...")
    this._daemon.stopDaemon()
    this.GatewayAddress = null
    this.APIAddress = null
    this._options = null
    this._daemon = null
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('uncaughtException')
    logger.debug("IPFS daemon finished")
  } 
   
}

module.exports = IpfsDaemon
