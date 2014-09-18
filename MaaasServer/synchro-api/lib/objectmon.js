﻿//
// objectDiff
//
// GitHub - https://github.com/NV/objectDiff.js
//
// NPM - objectdiff - https://npmjs.org/package/objectdiff 
//
// Visual diff app using objectDiff - http://nv.github.io/objectDiff.js/
//
var logger = require('log4js').getLogger("objectmon");

var objectDiff = require("objectdiff");

function recordChanges(path, diffs, recordChange)
{
    if (diffs.changed == "object change")
    {
        for (var property in diffs.value)
        {
            var propertyPath = property;
            if (path != null)
            {
                if (isNaN(property))
                {
                    propertyPath = path + "." + property;
                }
                else
                {
                    propertyPath = path + "[" + property + "]";
                }
            }

            switch (diffs.value[property].changed)
            {
                case "primitive change":
                    // Old value is in diffs.value[property].removed
                    recordChange("update", propertyPath, diffs.value[property].added);
                    break;
                case "added":
                    // A property or array element was added (value can be primitive or object)...
                    recordChange("add", propertyPath, diffs.value[property].value);
                    break;
                case "removed":
                    // A property or array element was removed (value can be primitive or object)...
                    // Old value is in diffs.value[property].value
                    recordChange("remove", propertyPath);
                    break;
                case "object change":
                    // The contents of an array or object changed...
                    recordChange("object", propertyPath);
                    recordChanges(propertyPath, diffs.value[property], recordChange);
                    break;
            }
        }
    }
}

function logChange(changeType, path, value)
{
    var msg = "Found change of type: " + changeType + " for property at path: " + path;
    if (value !== undefined)
    {
        msg += " vith value: " + value;
    }
    logger.debug(msg);
}

// For primitive changes...
//
// { path: "state.foo.bar", change: "add",    value: "foo" }
// { path: "state.foo.bar", change: "update", value: "foo" }
// { path: "state.foo.bar", change: "remove" }
//
// For object/array contents changed...
//
// { path: "state.foo" change: "object" }
//
exports.getChangeList = function(basePath, originalObject, newObject)
{
    // Doing "own properties" prevents inspection of prototype functions (among other things)
    var diffs = objectDiff.diffOwnProperties(originalObject, newObject);
    logger.debug("Diffs: ", JSON.stringify(diffs, null, 4));

    var changes = [];
    recordChanges(basePath, diffs, function (changeType, path, value)
    {
        logChange(changeType, path, value);
        changes.push({ path: path, change: changeType, value: value });
    });

    return changes;
}