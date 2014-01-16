﻿// Hello page
//
exports.View =
{
    title: "Hello World",
    onBack: "exit",
    elements:
    [
        { type: "stackpanel", orientation: "Horizontal", contents: [
            { type: "text", value: "First name:", fontsize: 12, margin: { top: 10, right: 10 } },
            { type: "edit", fontsize: 12, binding: "firstName" },
        ] },
        { type: "stackpanel", orientation: "Horizontal", contents: [
            { type: "text", value: "Last name:", fontsize: 12, margin: { top: 10, right: 10 } },
            { type: "edit", fontsize: 12, binding: "lastName" },
        ] },

        { type: "text", value: "Hello {firstName} {lastName}", fontsize: 12 },
    ]
}

exports.InitializeViewModel = function(context, session)
{
    var viewModel =
    {
        firstName: "Planet",
        lastName: "Earth",
    }
    return viewModel;
}

exports.Commands =
{
    exit: function(context)
    {
        return navigateToView(context, "menu");
    },
}