---
title: Image Scale
---

    // Image scaling page
    //
    exports.View =
    {
        title: "Image Scale",
        elements:
        [
            { control: "stackpanel", orientation: "Horizontal", contents: [
                { control: "button", width: 150, caption: "Landscape", binding: { command: "setImage", image: "landscape" } },
                { control: "button", width: 150, caption: "Square", binding: { command: "setImage", image: "square" } },
                { control: "button", width: 150, caption: "Portrait", binding: { command: "setImage", image: "portrait" } },
            ] },

            { control: "stackpanel", orientation: "Horizontal", contents: [
                { control: "button", width: 150, caption: "Stretch", binding: { command: "setScale", scale: "Stretch" } },
                { control: "button", width: 150, caption: "Fit", binding: { command: "setScale", scale: "Fit" } },
                { control: "button", width: 150, caption: "Fill", binding: { command: "setScale", scale: "Fill" } },
            ] },
            { control: "border", border: "Red", borderThickness: "5", contents: [
                { control: "image", resource: "{img}", scale: "{scale}", horizontalAlignment: "{alignH}", verticalAlignment: "{alignV}", margin: 0, height: "100", width: "100" },
            ] },

            { control: "border", border: "Red", borderThickness: "5", contents: [
                { control: "image", resource: "{img}", scale: "{scale}", horizontalAlignment: "{alignH}", verticalAlignment: "{alignV}", margin: 0, width: "100" },
            ] },

            { control: "border", border: "Red", borderThickness: "5", contents: [
                { control: "image", resource: "{img}", scale: "{scale}", horizontalAlignment: "{alignH}", verticalAlignment: "{alignV}", margin: 0, height: "100" },
            ] }
        ]
    }

    function imageUrl(img)
    {
        return "http://blob.synchro.io/resources/" + img + ".jpg";
    }

    exports.InitializeViewModel = function (context, session)
    {
        var viewModel =
        {
            img: imageUrl("landscape"),
            scale: null,
            alignH: "Center",
            alignV: "Center",
        }
        return viewModel;
    }

    exports.Commands =
    {
        setImage: function(context, session, viewModel, params)
        {
            viewModel.img = imageUrl(params.image);
        },
        setScale: function(context, session, viewModel, params)
        {
            viewModel.scale = params.scale;
        },
    }
