const fs = require('fs');
let c = fs.readFileSync('src/chat/lspilotChatViewProvider.ts', 'utf8');

c = c.replace(
  'toolsToUse = toolsDefinition;',
  "toolsToUse = [...toolsDefinition];\n              if (this.plan) {\n                toolsToUse.push({ type: 'function', function: { name: 'updatePlan', description: 'Update the current step-by-step plan you are working on. Call this tool with an updated markdown checklist whenever you complete a step.', parameters: { type: 'object', properties: { planText: { type: 'string', description: 'The updated plan formatted as a Markdown checklist.' } }, required: ['planText'] } } });\n              }"
);

c = c.replace(
  'if (tc.function.name === "setPlan") {',
  'if (tc.function.name === "setPlan" || tc.function.name === "updatePlan") {'
);

fs.writeFileSync('src/chat/lspilotChatViewProvider.ts', c);
