export const chatWebviewScript = `
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");
    const clearBtn = document.getElementById("clear");
    const selectModelBtn = document.getElementById("selectModel");
    const modelEl = document.getElementById("model");

    let state = { busy: false, modelLabel: "None", messages: [] };

    function appendMessage(message, index, openThinkingIndices) {
      const wrapper = document.createElement("div");
      wrapper.className = "msg " + message.role;

      const role = document.createElement("div");
      role.className = "role";
      role.textContent = message.role;
      wrapper.appendChild(role);

      if (message.role === "assistant" && typeof message.thinking === "string" && message.thinking.trim().length > 0) {
        const details = document.createElement("details");
        details.className = "thinking";
        details.dataset.msgIndex = String(index);
        if (openThinkingIndices.has(index)) {
          details.open = true;
        }

        const summary = document.createElement("summary");
        summary.textContent = "Thinking";
        details.appendChild(summary);

        const thinkingBody = document.createElement("div");
        thinkingBody.className = "thinking-body";
        thinkingBody.textContent = message.thinking;
        details.appendChild(thinkingBody);

        wrapper.appendChild(details);
      }

      if (typeof message.content === "string" && message.content.length > 0) {
        const content = document.createElement("div");
        content.textContent = message.content;
        wrapper.appendChild(content);
      } else if (message.role === "assistant") {
        const content = document.createElement("div");
        content.textContent = "Thinking...";
        wrapper.appendChild(content);
      }

      messagesEl.appendChild(wrapper);
    }

    function render() {
      modelEl.textContent = "Model: " + state.modelLabel;
      sendBtn.disabled = state.busy;
      inputEl.disabled = state.busy;

      const openThinkingIndices = new Set(
        Array.from(messagesEl.querySelectorAll("details.thinking[open]"))
          .map((el) => Number(el.dataset.msgIndex))
          .filter((value) => Number.isFinite(value))
      );

      messagesEl.textContent = "";

      for (let index = 0; index < state.messages.length; index += 1) {
        appendMessage(state.messages[index], index, openThinkingIndices);
      }

      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function sendInput() {
      const text = inputEl.value.trim();
      if (!text || state.busy) {
        return;
      }

      inputEl.value = "";
      vscode.postMessage({ type: "send", text });
    }

    sendBtn.addEventListener("click", sendInput);
    clearBtn.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
    selectModelBtn.addEventListener("click", () => vscode.postMessage({ type: "selectModel" }));
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendInput();
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "state") {
        state = message;
        render();
      }
    });

    vscode.postMessage({ type: "ready" });
`;
