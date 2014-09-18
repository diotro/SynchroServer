// World's second worst session store.
//
// Note: Since this requires write access to the local file system, it will not work on Azure/AWS.  This is only 
//       really suitable for testing session persistence on a locally running server.
//
// Note: If anyone was going to use this for some reason (or base something on it), at very least it should be made
//       asynchronous (async file IO combined with wait.for).
//
// Note: This is the session store for Synchro clients calling the Sycnhro API, and is not related to any web session store
//       for the admin/development web site.
//
var uuid = require('node-uuid');

var fs = require('fs');
var path = require('path');
var util = require('./util');

module.exports = function(params)
{
    var sessions = {};

    // Process params into locals
    
    var sessionFile = params.sessionStateFile;

    function deserializeJsonFromFile(filepath, defaultReturn)
    {
        // Attempt to read data from file
        //
        try
        {
            var contents = fs.readFileSync(filepath, 'utf8');
            if (contents)
            {
                // If contents found, parse and return
                //
                return JSON.parse(contents);
            }            
        }
        catch (err) 
        {
            // We'll ignore file not found, rethrow all others
            if (err.code !== 'ENOENT') 
                throw e;
        }

        return defaultReturn;
    }

    function serializeJsonToFile(filepath, obj)
    {
        var contents = JSON.stringify(sessions);
        fs.writeFileSync(filepath, contents, 'utf8');
    }

    function saveSessions()
    {
        serializeJsonToFile(sessionFile, sessions);
    }

    // Initial load of session data
    //
    sessions = deserializeJsonFromFile(sessionFile, sessions);

    var sessionStore = 
    {
        createSession: function()
        {
            var newSessionId = uuid.v4();
            sessions[newSessionId] = { id: newSessionId };
            saveSessions();
            return sessions[newSessionId];
        },

        getSession: function(sessionId)
        {
            if (sessionId)
            {
                return sessions[sessionId];
            }
            return null;
        },

        putSession: function(session)
        {
            // If the session put might be expensive, we could use objectmon to diff the current session with the potentially
            // updated version (if doing a read of the stored session, plus the compare, and the occasional write is actually
            // faster than just always doing a write).
            //
            sessions[session.id] = session;
            saveSessions();
        },

        deleteSession: function(sessionId)
        {
            delete sessions[sessionId];
            saveSessions();
        }
    }

    return sessionStore;
}