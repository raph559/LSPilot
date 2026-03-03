export const chatWebviewScript = `
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");
    const stopBtn = document.getElementById("stop");
    const clearBtn = document.getElementById("clear");
    const selectModelBtn = document.getElementById("selectModel");
    const modelEl = document.getElementById("model");
    const contextEl = document.getElementById("context");
    const contextLabelEl = document.getElementById("contextLabel");
    const contextFillEl = document.getElementById("contextFill");

    let state = { busy: false, busyStartTimeMs: undefined, modelLabel: "None", modelLoading: false, messages: [], contextUsage: undefined };
    let timerInterval = null;

    function formatTime(ms) {
      if (!ms || ms < 0) return "0.0s";
      return (ms / 1000).toFixed(1) + "s";
    }

    function updateTimers() {
      const activeTimer = document.getElementById("active-timer");
      if (activeTimer && state.busyStartTimeMs) {
        activeTimer.textContent = formatTime(Date.now() - state.busyStartTimeMs);
      }
    }

    function updateMessageDOM(message, index) {
      let outerWrapper = messagesEl.children[index];
      
      if (!outerWrapper) {
        outerWrapper = document.createElement("div");
        outerWrapper.className = "msg-wrapper " + message.role;
        outerWrapper.dataset.role = message.role;

        const role = document.createElement("div");
        role.className = "role";
        role.textContent = message.role.charAt(0).toUpperCase() + message.role.slice(1);
        outerWrapper.appendChild(role);
        
        const wrapper = document.createElement("div");
        wrapper.className = "msg " + message.role;
        outerWrapper.appendChild(wrapper);

        messagesEl.appendChild(outerWrapper);
      } else {
        if (outerWrapper.dataset.role !== message.role) {
           outerWrapper.className = "msg-wrapper " + message.role;
           outerWrapper.dataset.role = message.role;
           outerWrapper.querySelector('.role').textContent = message.role.charAt(0).toUpperCase() + message.role.slice(1);
           outerWrapper.querySelector('.msg').className = "msg " + message.role;
        }
      }

      const wrapper = outerWrapper.querySelector('.msg');

      let details = wrapper.querySelector('details.thinking');
      if (message.role === "assistant" && typeof message.thinking === "string" && message.thinking.trim().length > 0) {
        if (!details) {
          details = document.createElement("details");
          details.className = "thinking";
          details.dataset.msgIndex = String(index);

          const summary = document.createElement("summary");
          summary.textContent = "Thinking";
          details.appendChild(summary);

          const thinkingBody = document.createElement("div");
          thinkingBody.className = "thinking-body markdown-body";
          details.appendChild(thinkingBody);

          wrapper.insertBefore(details, wrapper.firstChild);
        } else {
          details.dataset.msgIndex = String(index);
        }
        
        const thinkingBody = details.querySelector('.thinking-body');
        const targetThinkingHTML = message.renderedThinking || "";
        if (thinkingBody.innerHTML !== targetThinkingHTML) {
          thinkingBody.innerHTML = targetThinkingHTML;
        }
      } else if (details) {
        details.remove();
      }

      let contentEl = wrapper.querySelector('.msg-content');
      if (!contentEl) {
        if (message.role === "tool") {
          wrapper.className = "msg tool-msg-container";
          
          const details = document.createElement("details");
          details.className = "tool-details";
          
          const summary = document.createElement("summary");
          summary.className = "tool-summary";
          
          const iconSvg = '<svg style="width:14px;height:14px;vertical-align:text-bottom;margin-right:4px;" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 1h11l.5.5v13l-.5.5h-11l-.5-.5v-13l.5-.5zM2 2v12h12V2H2zm3.85 4.15L8.7 8l-2.85 1.85-.7-.7L7.3 8 5.15 6.85l.7-.7zM11 10H8v1h3v-1z"></path></svg>';
          
          // Use tool name
          const nameSpan = document.createElement("span");
          nameSpan.innerHTML = iconSvg + " Used <b>" + (message.name || "Tool") + "</b>";
          
          summary.appendChild(nameSpan);
          details.appendChild(summary);
          
          const pre = document.createElement("pre");
          pre.className = "tool-output-pre";
          const code = document.createElement("code");
          code.className = "msg-content tool-output-code"; // msg-content marks it for text upd
          pre.appendChild(code);
          
          details.appendChild(pre);
          wrapper.appendChild(details);
          
          contentEl = code;
        } else {
          contentEl = document.createElement("div");
          contentEl.className = "msg-content markdown-body";
          wrapper.appendChild(contentEl);
        }
      }
      
      let targetContentHTML = "";
      if (message.renderedContent) {
        targetContentHTML = message.renderedContent;
      } else if (typeof message.content === "string" && message.content.length > 0) {
        // Fallback or while typing if renderedContent is somehow missing
        targetContentHTML = message.content; 
      } else if (message.role === "assistant") {
        targetContentHTML = "<em>Thinking...</em>";
      }

      if (message.role === "tool") {
        if (contentEl.textContent !== targetContentHTML) {
          contentEl.textContent = targetContentHTML;
        }
      } else {
        if (contentEl.innerHTML !== targetContentHTML) {
          contentEl.innerHTML = targetContentHTML;
        }
      }

      // Timer
      let timerEl = outerWrapper.querySelector('.timer');
      if (message.role === "assistant") {
        let timerText = "";
        let timerId = "";
        if (typeof message.generationTimeMs === "number") {
          timerText = formatTime(message.generationTimeMs);
        } else if (state.busy && index === state.messages.length - 1 && state.busyStartTimeMs) {
          timerId = "active-timer";
          timerText = formatTime(Date.now() - state.busyStartTimeMs);
        }
        
        if (timerText) {
          if (!timerEl) {
            timerEl = document.createElement("div");
            timerEl.className = "timer";
            outerWrapper.appendChild(timerEl);
          }
          timerEl.id = timerId;
          if (timerEl.textContent !== timerText) {
            timerEl.textContent = timerText;
          }
        } else if (timerEl) {
          timerEl.remove();
        }
      } else if (timerEl) {
        timerEl.remove();
      }
    }

    function render() {
      modelEl.textContent = "Model: " + state.modelLabel + (state.modelLoading ? " (Loading...)" : "");
      const noModel = !state.modelLabel || state.modelLabel === "None";

      const usage = state.contextUsage;
      if (usage && typeof usage.usagePercent === "number") {
        contextEl.classList.remove("hidden");
        const pct = Math.max(0, Math.min(100, Number(usage.usagePercent)));
        const used = Number(usage.totalTokens || 0).toLocaleString();
        const total = Number(usage.contextWindowTokens || 0).toLocaleString();
        contextLabelEl.textContent = "Context " + pct.toFixed(1) + "% (" + used + "/" + total + ")";
        contextFillEl.style.clipPath = "inset(0 " + (100 - pct) + "% 0 0)";
        contextEl.title = typeof usage.details === "string" ? usage.details : "";
      } else {
        contextEl.classList.add("hidden");
      }

      sendBtn.disabled = state.busy || noModel || state.modelLoading;
      
      if (state.busy) {
        sendBtn.classList.add("hidden");
        stopBtn.classList.remove("hidden");
      } else {
        sendBtn.classList.remove("hidden");
        stopBtn.classList.add("hidden");
      }

      if (state.modelLoading) {
        sendBtn.textContent = "Loading...";
      } else {
        sendBtn.textContent = "Send";
      }

      inputEl.disabled = state.busy || noModel;
      inputEl.placeholder = noModel 
        ? "Select a model to start chatting..." 
        : "Ask something about your code...";

      // Maintain scroll position if at bottom
      const isAtBottom = messagesEl.scrollHeight - messagesEl.clientHeight <= messagesEl.scrollTop + 10;

      for (let index = 0; index < state.messages.length; index += 1) {
        updateMessageDOM(state.messages[index], index);
      }

      while (messagesEl.children.length > state.messages.length) {
        messagesEl.removeChild(messagesEl.lastChild);
      }

      if (isAtBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      if (state.busy && state.busyStartTimeMs) {
        if (!timerInterval) {
          timerInterval = setInterval(updateTimers, 100);
        }
      } else {
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
      }
    }

    function sendInput() {
      const text = inputEl.value.trim();
      if (!text || state.busy) {
        return;
      }

      // Auto-resize reset
      inputEl.style.height = 'auto';
      inputEl.value = "";
      vscode.postMessage({ type: "send", text });
    }

    // Auto-resize textarea
    inputEl.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
    });

    sendBtn.addEventListener("click", sendInput);
    stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    clearBtn.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
    selectModelBtn.addEventListener("click", () => vscode.postMessage({ type: "selectModel" }));
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendInput();
      }
    });

    // Global copy function for inline onclick handler
    window.copyCode = function(buttonEl) {
      const wrapper = buttonEl.closest('.code-block-wrapper');
      if (!wrapper) return;
      
      const clone = wrapper.cloneNode(true);
      // Remove line numbers before copying
      const lineNumbers = clone.querySelectorAll('.ln');
      lineNumbers.forEach(ln => ln.remove());
      // Get exact code
      const codeMatches = clone.querySelectorAll('code');
      let textToCopy = '';
      if (codeMatches.length > 0) {
         textToCopy = codeMatches[0].innerText;
      }
      
      // Cleanup extra newlines inserted by the span removal if needed
      textToCopy = textToCopy.replace(/\\n+/g, '\\n').trim();

      navigator.clipboard.writeText(textToCopy).then(() => {
        buttonEl.classList.add('success');
        const originalHtml = buttonEl.innerHTML;
        buttonEl.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>';
        setTimeout(() => {
          buttonEl.classList.remove('success');
          buttonEl.innerHTML = originalHtml;
        }, 2000);
      });
    };

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "state") {
        state = message;
        render();
      }
    });

    vscode.postMessage({ type: "ready" });
`;
