"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var marked_highlight_1 = require("marked-highlight");
var ext = (0, marked_highlight_1.markedHighlight)({ highlight: function (c) { return c; } });
console.log(ext.renderer.code);
