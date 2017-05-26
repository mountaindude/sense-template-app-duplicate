const enigma = require('enigma.js');
const WebSocket = require('ws');
const fs = require('fs');
const util = require('util')
var qrsInteract = require('qrs-interact');
var request = require('request');
var restify = require('restify');
var winston = require('winston');
var config = require('config');



// Set up Winston logger, logging both to console and different disk files
var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({
            name: 'console_log',
            'timestamp': true,
            'colorize': true
        }),
        new (winston.transports.File)({
            name: 'file_info',
            filename: config.get('logDirectory') + '/info.log',
            level: 'info'
        }),
        new (winston.transports.File)({
            name: 'file_verbose',
            filename: config.get('logDirectory') + '/verbose.log',
            level: 'verbose'
        }),
        new (winston.transports.File)({
            name: 'file_error',
            filename: config.get('logDirectory') + '/error.log',
            level: 'error'
        })
    ]
});

// Set default log level
logger.transports.console_log.level = config.get('defaultLogLevel');

logger.log('info', 'Starting Qlik Sense template app duplicator.');


// Read certificates
const client = fs.readFileSync(config.get('clientCertPath'));
const client_key = fs.readFileSync(config.get('clientCertKeyPath'));

// Read load script from wherever it is stored (Github etc)
const loadScriptURL = config.get('loadScriptURL');

// Set up enigma.js configuration
const qixSchema = require('enigma.js/schemas/qix/3.2/schema.json');
const configEnigma = {
    schema: qixSchema,
    session: {
        host: config.get('host'),
        port: 4747, // Standard Engine port
        secure: config.get('isSecure'),
        disableCache: true
    },
    createSocket: (url, sessionConfig) => {
        return new WebSocket(url, {
            // ca: rootCert,
            key: client_key,
            cert: client,
            headers: {
                'X-Qlik-User': 'UserDirectory=Internal;UserId=sa_repository'
            },
            rejectUnauthorized: false
        });
    }
}



// Set up Sense repository service configuration
var configQRS = {
    hostname: config.get('host'),
    certificates: {
        certFile: config.get('clientCertPath'),
        keyFile: config.get('clientCertKeyPath'),
    }
}


var restServer = restify.createServer({
    name: 'Qlik Sense app duplicator',
    version: '1.1.0',
    certificate: fs.readFileSync(config.get('sslCertPath')),
    key: fs.readFileSync(config.get('sslCertKeyPath'))
});


// Enable parsing of http parameters
restServer.use(restify.queryParser());

// Set up CORS handling
restServer.use(restify.CORS({ origins: ['*'] }));

// Set up endpoints for REST server
restServer.get('/duplicateNewScript', respondDuplicateNewScript);
restServer.get('/duplicateKeepScript', respondDuplicateKeepScript);
restServer.get('/getTemplateList', respondGetTemplateList);


// Start the server
restServer.listen(8001, function () {
    console.log('%s listening at %s', restServer.name, restServer.url);
});



// Handler for REST endpoint /getTemplateList
// URL parameters
//   -- None --
function respondGetTemplateList(req, res, next) {
    configQRS.headers = { 'X-Qlik-User': 'UserDirectory=Internal; UserId=sa_repository' };
    logger.log('verbose', configQRS);

    var qrsInteractInstance = new qrsInteract(configQRS);

    var appList = [];

    qrsInteractInstance.Get("app/full?filter=@AppIsTemplate eq 'Yes'")
        .then(result => {
            logger.log('debug', 'result=' + result);

            result.body.forEach(function (element) {
                appList.push({
                    name: element.name,
                    id: element.id,
                    description: element.description
                });

                logger.log('verbose', 'Element name: ' + element.name);
                logger.log('verbose', 'App list JSON: ' + JSON.stringify(appList));
            }, this);

            logger.log('info', 'Done getting list of template apps');

            res.send(appList);

        })
        .catch(err => {
            // Return error msg
            logger.log('error', 'Get templates: ' + err);
            res.send(err);
        })

    next();
}





// Handler for REST endpoint /duplicateNewScript
// URL parameters
//   templateAppId: ID of app to use as template
//   appName: Name of the new app that is created
//   ownerUserId: User ID that should be set as owner of the created app
function respondDuplicateNewScript(req, res, next) {

    // Add owner of new app as header in call to QRS. That way this user will automatically be owner of the newly created app.
    configQRS.headers = { 'X-Qlik-User': 'UserDirectory=' + config.get('senseUserDirectory') + '; UserId=' + req.params.ownerUserId };
    logger.log('debug', configQRS);

    var qrsInteractInstance = new qrsInteract(configQRS);

    // Load script from git
    request.get(loadScriptURL, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            logger.log('verbose', 'Retrieved load script');

            var loadScript = body;
            logger.log('debug', 'Load script: ' + loadScript);

            enigma.getService('qix', configEnigma).then((qix) => {
                const g = qix.global;
                logger.log('debug', req.params.appName + ': Got the global instance');
            });

            var newAppId = '';

            var newOwnerId, newOwnerUserDirectory, newOwnerName;
            var newOwnerUserId = req.params.ownerUserId;

            // Get config data on whether to reload the new app or not
            var reloadNewApp = config.get('reloadNewApp'); 

            // Make sure the app to be duplicated really is a template
            qrsInteractInstance.Get('app/' + req.params.templateAppId).then(result => {
                logger.log('verbose', req.params.templateAppId + 'Testing if specifiec template app really is a template');

                var appIsTemplate = false;
                result.body.customProperties.forEach(function (item) {
                    logger.log('debug', 'Item: ' + item);

                    if (item.definition.name == 'AppIsTemplate' && item.value == 'Yes') {
                        appIsTemplate = true;
                    }
                })

                logger.log('verbose', req.params.templateAppId + 'App is template: ' + appIsTemplate);

                if (!appIsTemplate) {
                    logger.log('warn', 'The provided app ID does not belong to a template app');
                    next(new restify.InvalidArgumentError("The provided app ID does not belong to a template app."));
                }

                return appIsTemplate;
            })
            .then(result => {
                // result == true if the provided app ID belongs to a template app
                if (result) {
                    qrsInteractInstance.Post('app/' + req.params.templateAppId + '/copy?name=' + req.params.appName, {}, 'json').then(result => {
                        logger.log('info', 'App created with ID %s, using %s as a template ', result.body.id, req.params.templateAppId);
                        newAppId = result.body.id;

                        enigma.getService('qix', configEnigma).then((qix) => {
                            const g = qix.global;

                            // Connect to engine
                            logger.log('verbose', req.params.appName + ': Connecting to engine...');

                            g.openApp(newAppId).then((app) => {
                                logger.log('verbose', 'Setting load script...');
                                app.setScript(loadScript).then((app) => {

                                    // Do a reload of the new app?
                                    if (reloadNewApp) {
                                        logger.log('verbose', req.params.appName + ': Reload app...');
                                        app.doReload();
                                    } else {
                                        logger.log('verbose', req.params.appName + ': App reloading disabled - skipping.');
                                    }

                                    // Close our connection.
                                    logger.log('verbose', req.params.appName + ': Close connection to engine...');
                                    g.session.close().then(() => {
                                        logger.log('info', req.params.appName + ': Done duplicating, new app id=' + newAppId);
                                        var jsonResult = { result: "Done duplicating app", newAppId: newAppId }
                                        res.send(jsonResult);
                                        next();
                                    })
                                    .catch(err => {
                                        // Return error msg
                                        logger.log('error', 'Duplication error 1: ' + err);
                                        next(new restify.BadRequestError("Error occurred when test app template status."));;
                                        return;
                                    })
                                    logger.log('verbose', req.params.appName + ': Connection closed...');
                                })
                                .catch(err => {
                                    // Return error msg
                                    logger.log('error', 'Duplication error 2: ' + err);
                                    next(new restify.BadRequestError("Error occurred when test app template status."));;
                                    return;
                                });
                            })
                            .catch(err => {
                                // Return error msg
                                logger.log('error', 'Duplication error 2: ' + err);
                                next(new restify.BadRequestError("Error occurred when test app template status."));;
                                return;
                            });
                        })
                        .catch(err => {
                            // Return error msg
                            logger.log('error', 'Duplication error 2: ' + err);
                            next(new restify.BadRequestError("Error occurred when test app template status."));;
                            return;
                        });

                    })
                    .catch(err => {
                        // Return error msg
                        logger.log('error', 'Duplication error 3: ' + err);
                        next(new restify.BadRequestError("Error occurred when test app template status."));;
                        return;
                    });
                }
            })
            .catch(err => {
                // Return error msg
                logger.log('error', 'Duplication error 4: ' + err);
                next(new restify.BadRequestError("Error occurred when test app template status."));;
                return;
            });
        }
    })
}





// Handler for REST endpoint /duplicateKeepScript
// URL parameters
//   templateAppId: ID of app to use as template
//   appName: Name of the new app that is created
//   ownerUserId: User ID that should be set as owner of the created app
function respondDuplicateKeepScript(req, res, next) {

    // Add owner of new app as header in call to QRS. That way this user will automatically be owner of the newly created app.
    configQRS.headers = { 'X-Qlik-User': 'UserDirectory=' + config.get('senseUserDirectory') + '; UserId=' + req.params.ownerUserId };
    logger.log('debug', configQRS);

    var qrsInteractInstance = new qrsInteract(configQRS);

    enigma.getService('qix', configEnigma).then((qix) => {
        const g = qix.global;
        logger.log('debug', req.params.appName + ': Got the global instance');
    });

    var newAppId = '';

    var newOwnerId, newOwnerUserDirectory, newOwnerName;
    var newOwnerUserId = req.params.ownerUserId;

    // Get config data on whether to reload the new app or not
    var reloadNewApp = config.get('reloadNewApp'); 

    // Make sure the app to be duplicated really is a template
    qrsInteractInstance.Get('app/' + req.params.templateAppId)
        .then(result => {
            logger.log('verbose', req.params.templateAppId + 'Testing if specifiec template app really is a template');

            var appIsTemplate = false;
            result.body.customProperties.forEach(function (item) {
                logger.log('debug', 'Item: ' + item);

                if (item.definition.name == 'AppIsTemplate' && item.value == 'Yes') {
                    appIsTemplate = true;
                }
            })

            logger.log('verbose', req.params.templateAppId + 'App is template: ' + appIsTemplate);

            if (!appIsTemplate) {
                logger.log('warn', 'The provided app ID does not belong to a template app');
                next(new restify.InvalidArgumentError("The provided app ID does not belong to a template app."));
            }

            return appIsTemplate;
        })
        .then(result => {
            // result == true if the provided app ID belongs to a template app
            if (result) {
                qrsInteractInstance.Post('app/' + req.params.templateAppId + '/copy?name=' + req.params.appName, {}, 'json').then(result => {
                    logger.log('info', 'App created with ID %s, using %s as a template ', result.body.id, req.params.templateAppId);
                    newAppId = result.body.id;

                    enigma.getService('qix', configEnigma).then((qix) => {
                        const g = qix.global;

                        // Connect to engine
                        logger.log('verbose', req.params.appName + ': Connecting to engine...');

                        g.openApp(newAppId).then((app) => {
                            // Do a reload of the new app?
                            if (reloadNewApp) {
                                logger.log('verbose', req.params.appName + ': Reload app...');
                                app.doReload();
                            } else {
                                logger.log('verbose', req.params.appName + ': App reloading disabled - skipping.');
                            }

                            // Close our connection.
                            logger.log('verbose', req.params.appName + ': Close connection to engine...');
                            g.session.close().then(() => {
                                logger.log('info', req.params.appName + ': Done duplicating, new app id=' + newAppId);
                                var jsonResult = { result: "Done duplicating app", newAppId: newAppId }
                                res.send(jsonResult);
                                next();
                            })
                            .catch(err => {
                                // Return error msg
                                logger.log('error', 'Duplication error 1: ' + err);
                                next(new restify.BadRequestError("Error occurred when test app template status."));;
                                return;
                            })
                            logger.log('verbose', req.params.appName + ': Connection closed...');
                        })
                        .catch(err => {
                            // Return error msg
                            logger.log('error', 'Duplication error 2: ' + err);
                            next(new restify.BadRequestError("Error occurred when test app template status."));;
                            return;
                        });
                    })
                    .catch(err => {
                        // Return error msg
                        logger.log('error', 'Duplication error 3: ' + err);
                        next(new restify.BadRequestError("Error occurred when test app template status."));;
                        return;
                    })
                })
                .catch(err => {
                    // Return error msg
                    logger.log('error', 'Duplication error 4: ' + err);
                    next(new restify.BadRequestError("Error occurred when test app template status."));;
                    return;
                })
            }
        })
        .catch(err => {
            // Return error msg
            logger.log('error', 'Duplication error 5: ' + err);
            // res.send(err);
            next(new restify.BadRequestError("Error occurred when test app template status."));;
            return;
        })

}
