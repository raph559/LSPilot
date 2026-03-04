export const chatWebviewScript = `
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");
    const stopBtn = document.getElementById("stop");
    const thinkingToggleBtn = document.getElementById("thinkingToggle");
    const clearBtn = document.getElementById("clear");
    const selectModelBtn = document.getElementById("selectModel");
    const modelEl = document.getElementById("model");
    const contextEl = document.getElementById("context");
    const contextLabelEl = document.getElementById("contextLabel");
    const contextFillEl = document.getElementById("contextFill");

    let state = { busy: false, busyStartTimeMs: undefined, modelLabel: "None", modelLoading: false, thinkingEnabled: false, thinkingSupported: false, messages: [], contextUsage: undefined };
    let timerInterval = null;
    let promptHistory = [];
    let promptHistoryIndex = -1;

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
        
        const roleEl = outerWrapper.querySelector('.role');
        if (roleEl) {
          let hideRole = false;
          if (index > 0) {
            const prevMessage = state.messages[index - 1];
            if (message.role === "assistant" || message.role === "tool") {
              if (prevMessage.role === "assistant" || prevMessage.role === "tool") hideRole = true;
            } else if (message.role === "user") {
              if (prevMessage.role === "user") hideRole = true;
            }
          }
          if (hideRole) {
             roleEl.style.display = "none";
          } else {
             roleEl.style.display = ""; // fallback to css default which handles flex/none for tools 
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

          const card = document.createElement("div");
          card.className = "tool-card";

          const details = document.createElement("details");
          details.className = "tool-details";

          const summary = document.createElement("summary");
          summary.className = "tool-summary";

          const iconSvg = '<i class="codicon codicon-symbol-misc" style="margin-right: 6px; font-size: 14px; vertical-align: text-bottom;"></i>';
          
          const nameSpan = document.createElement("span");
          if (message.toolSummary) {
             nameSpan.innerHTML = iconSvg + " Used <b>" + message.toolSummary + "</b>";
          } else {
             nameSpan.innerHTML = iconSvg + " Used <b>" + (message.name || "Tool") + "</b>";
          }

          summary.appendChild(nameSpan);
          details.appendChild(summary);

          const body = document.createElement("div");
          body.className = "tool-output-body markdown-body msg-content"; 
          details.appendChild(body);

          card.appendChild(details);

          wrapper.appendChild(card);

          const editActionsEl = document.createElement("div");
          editActionsEl.className = "edit-actions-container";
          editActionsEl.style.display = "none";
          wrapper.appendChild(editActionsEl);

          contentEl = body;
        } else {
          contentEl = document.createElement("div");
          contentEl.className = "msg-content markdown-body";
          wrapper.appendChild(contentEl);
        }
      }
      
      let targetContentHTML = "";
      if (typeof message.renderedContent === "string" && message.renderedContent.length > 0) {
        targetContentHTML = message.renderedContent;
      } else if (typeof message.content === "string" && message.content.length > 0) {
        // Fallback or while typing if renderedContent is somehow missing
        targetContentHTML = message.content; 
      } else if (message.role === "assistant" && state.busy && index === state.messages.length - 1) {
        if (!message.thinking || message.thinking.length === 0) {
          targetContentHTML = "<em>Thinking...</em>";
        }
      }

      if (message.role === "tool" && message._groupStart === index) {
        const count = message._relatedIndices.length;
        const displayName = count > 1 ? "Used " + message.name + " on " + count + " files" : (message.toolSummary || "Used " + message.name);

        const summarySpan = wrapper.querySelector('.tool-summary span');
        if (summarySpan) {
            const iconSvg = '<i class="codicon codicon-symbol-misc" style="margin-right: 6px; font-size: 14px; vertical-align: text-bottom;"></i>';
            summarySpan.innerHTML = iconSvg + " <b>" + displayName + "</b>";
        }

        let combinedHtml = "";
        for (const i of message._relatedIndices) {
            const m = state.messages[i];
            if (m.name === "writeFile" && m.fileEdit && !m.fileEdit.superseded) {
                const fileName = (m.fileEdit.filePath || "").split(/[\\\\/]/).pop();
                const additions = m.fileEdit.additions || 0;
                const deletions = m.fileEdit.deletions || 0;
                
                combinedHtml += '<div class="global-edit-card" style="margin-top: 8px; cursor: pointer;" title="View Diff" data-action="showDiff" data-index="' + i + '">';
                const fileIcon = '<i class="codicon codicon-diff" style="margin-right: 6px; font-size: 16px; vertical-align: text-bottom;"></i>';
                
                combinedHtml += '<div class="edit-file-name" style="flex:1;">' +
                    '<div style="font-size: 1.25em; font-weight: 500; display: inline-flex; align-items: center;">' +
                      fileIcon + '<span>' + fileName + '</span>' +
                    '</div>' +
                    '<span class="diff-stats" style="margin-left: 8px; font-size: 11px;">' +
                      '<span style="color: var(--vscode-charts-green, #4caf50);">+' + additions + '</span>' +
                      '<span style="color: var(--vscode-charts-red, #d64545);">-' + deletions + '</span>' +
                    '</span>' +
                  '</div>' +
                  '<div class="hover-actions" style="opacity: 1;">' +
                     '<button class="icon-btn" title="View Diff"><i class="codicon codicon-go-to-file" style="font-size: 14px;"></i></button>' +
                  '</div>' +
                '</div>';
            } else if (m.name === "readFile") {
                let fileName = "file";
                if (m.toolSummary) {
                    const match = m.toolSummary.match(/on\\s+<b>([^<]+)<\\/b>/);
                    if (match) fileName = match[1];
                }
                combinedHtml += '<div class="global-edit-card" style="margin-top: 8px; cursor: pointer;" title="Open File" data-action="openFile" data-index="' + i + '">';
                const fileIcon = '<i class="codicon codicon-file-code" style="margin-right: 6px; font-size: 16px; vertical-align: text-bottom;"></i>';
                
                combinedHtml += '<div class="edit-file-name" style="flex:1;">' +
                    '<div style="font-size: 1.25em; font-weight: 500; display: inline-flex; align-items: center;">' +
                      fileIcon + '<span>' + fileName + '</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="hover-actions" style="opacity: 1;">' +
                     '<button class="icon-btn" title="Open File"><i class="codicon codicon-go-to-file" style="font-size: 14px;"></i></button>' +
                  '</div>' +
                '</div>';
            } else {
                const text = m.content || "";
                const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                combinedHtml += '<div class="global-edit-card" style="margin-top: 8px;"><div style="white-space:pre-wrap; font-family:var(--vscode-editor-font-family); font-size:12px;">' + safeText + '</div></div>';
            }
        }
        targetContentHTML = combinedHtml;
      }

      if (message.role === "tool") {
        if (message._groupStart !== index) {
            outerWrapper.style.display = "none";
        } else {
            outerWrapper.style.display = "flex";
            if (contentEl.innerHTML !== targetContentHTML) {
               contentEl.innerHTML = targetContentHTML;
            }
            const actionsContainer = wrapper.querySelector('.edit-actions-container');
            if (actionsContainer) {
               actionsContainer.style.display = "none";
            }
            
            const detailsEl = wrapper.querySelector('details.tool-details');
            if (detailsEl && !detailsEl.hasAttribute('data-opened')) {
               // Leave it closed by default, but mark it as processed
               detailsEl.setAttribute('data-opened', 'true');
            }
        }
      } else {
        if (contentEl.innerHTML !== targetContentHTML) {
          contentEl.innerHTML = targetContentHTML;
        }
      }

      // Hide completely if empty (assistant/user with no text, not thinking)
      if (message.role !== "tool") {
        const hasContent = targetContentHTML.trim().length > 0;
        const hasThinking = typeof message.thinking === "string" && message.thinking.length > 0;
        
        if (!hasContent && !hasThinking) {
          outerWrapper.style.display = "none";
        } else {
          outerWrapper.style.display = "flex";
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
      let currentGroupStart = -1;
      for (let i = 0; i < state.messages.length; i++) {
        const msg = state.messages[i];
        msg._relatedIndices = [];
        if (msg.role === "tool") {
          const countLimit = 100; // prevent unbounded groups
          const prevCount = currentGroupStart !== -1 ? state.messages[currentGroupStart]._relatedIndices.length : 0;
          if (currentGroupStart !== -1 && state.messages[currentGroupStart].role === "tool" && state.messages[currentGroupStart].name === msg.name && prevCount < countLimit) {
            msg._groupStart = currentGroupStart;
            state.messages[currentGroupStart]._relatedIndices.push(i);
          } else {
            currentGroupStart = i;
            msg._groupStart = i;
            msg._relatedIndices = [i];
          }
        } else {
          // Check if this message is basically an invisible "empty" message.
          let hasContent = false;
          if (typeof msg.renderedContent === "string" && msg.renderedContent.trim().length > 0) hasContent = true;
          else if (typeof msg.content === "string" && msg.content.trim().length > 0) hasContent = true;
          
          let hasThinking = false;
          if (typeof msg.thinking === "string" && msg.thinking.trim().length > 0) hasThinking = true;

          // If the assistant message has content or thinking, or it's a user message, break the tool sequence group.
          if (msg.role === "user" || hasContent || hasThinking) {
             currentGroupStart = -1;
          }
        }
      }

      modelEl.textContent = "Model: " + state.modelLabel + (state.modelLoading ? " (Loading...)" : "");
      const noModel = !state.modelLabel || state.modelLabel === "None";
      const modelSupportsThinking = !!state.thinkingSupported;

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
      const thinkingDisabled = state.busy || noModel || state.modelLoading;
      thinkingToggleBtn.disabled = thinkingDisabled;
      thinkingToggleBtn.classList.toggle("active", !!state.thinkingEnabled);
      thinkingToggleBtn.classList.toggle("supported-off", modelSupportsThinking && !state.thinkingEnabled);
      thinkingToggleBtn.classList.toggle("unsupported", !noModel && !modelSupportsThinking);
      thinkingToggleBtn.classList.toggle("crossed", !noModel && !modelSupportsThinking);
      if (noModel) {
        thinkingToggleBtn.title = "Select a model to use deep thinking";
      } else if (!modelSupportsThinking) {
        thinkingToggleBtn.title = state.thinkingEnabled
          ? "Deep thinking enabled (best effort; model support not detected)"
          : "Deep thinking disabled (strict mode; tool calls unavailable)";
      } else if (state.thinkingEnabled) {
        thinkingToggleBtn.title = "Disable deep thinking (strict mode; tool calls unavailable)";
      } else {
        thinkingToggleBtn.title = "Enable deep thinking (tool calls available)";
      }
      thinkingToggleBtn.setAttribute("aria-label", thinkingToggleBtn.title);
      thinkingToggleBtn.setAttribute("aria-pressed", state.thinkingEnabled ? "true" : "false");
      
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

      inputEl.disabled = noModel;
      if (noModel) {
        inputEl.placeholder = "Select a model to start chatting...";
      } else if (state.modelLoading) {
        inputEl.placeholder = "Loading model... you can type your prompt now.";
      } else {
        inputEl.placeholder = "Ask something about your code...";
      }

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
      const noModel = !state.modelLabel || state.modelLabel === "None";
      if (!text || state.busy || state.modelLoading || noModel) {
        return;
      }

      promptHistory.push(text);
      promptHistoryIndex = promptHistory.length;

      // Auto-resize reset
      inputEl.style.height = 'auto';
      inputEl.value = "";
      vscode.postMessage({ type: "send", text, enableThinking: !!state.thinkingEnabled });
    }

    // Auto-resize textarea
    inputEl.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
    });

    sendBtn.addEventListener("click", sendInput);
    thinkingToggleBtn.addEventListener("click", () => {
      const noModel = !state.modelLabel || state.modelLabel === "None";
      if (state.busy || state.modelLoading || noModel) {
        return;
      }
      const nextEnabled = !state.thinkingEnabled;
      state.thinkingEnabled = nextEnabled;
      render();
      vscode.postMessage({ type: "toggleThinking", enabled: nextEnabled });
    });
    stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    clearBtn.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
    selectModelBtn.addEventListener("click", () => vscode.postMessage({ type: "selectModel" }));
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendInput();
      } else if (event.key === "ArrowUp") {
        if (promptHistory.length > 0 && promptHistoryIndex > 0) {
          event.preventDefault();
          promptHistoryIndex--;
          inputEl.value = promptHistory[promptHistoryIndex];
          // Trigger auto-resize
          inputEl.dispatchEvent(new Event('input'));
        }
      } else if (event.key === "ArrowDown") {
        if (promptHistory.length > 0 && promptHistoryIndex < promptHistory.length) {
          event.preventDefault();
          promptHistoryIndex++;
          if (promptHistoryIndex === promptHistory.length) {
            inputEl.value = "";
          } else {
            inputEl.value = promptHistory[promptHistoryIndex];
          }
          // Trigger auto-resize
          inputEl.dispatchEvent(new Event('input'));
        }
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

    // Global click delegate for dynamically rendered action cards (Diff / Open File)
    document.addEventListener("click", (event) => {
       const target = event.target.closest('[data-action]');
       if (!target) return;

       const action = target.getAttribute('data-action');
       const indexStr = target.getAttribute('data-index');
       if (!indexStr) return;

       const index = parseInt(indexStr, 10);

       if (action === "showDiff") {
           vscode.postMessage({ type: 'showDiff', index: index });
       } else if (action === "openFile") {
           vscode.postMessage({ type: 'openFile', index: index });
       }
    });

    const renderGlobalPendingEdits = () => {
      const container = document.getElementById("globalPendingEdits");
      if (!container) return;

      container.innerHTML = "";

      const pendingIndices = [];
      let totalAdditions = 0;
      let totalDeletions = 0;

      if (state.messages && state.messages.length > 0) {
         for (let i = 0; i < state.messages.length; i++) {
           const m = state.messages[i];
           if (m.role === "tool" && m.fileEdit && !m.fileEdit.discarded && !m.fileEdit.applied && !m.fileEdit.superseded) {
              pendingIndices.push(i);
              totalAdditions += (m.fileEdit.additions || 0);
              totalDeletions += (m.fileEdit.deletions || 0);
           }
         }
      }

      if (pendingIndices.length === 0) {
        container.style.display = "none";
        return;
      }

      container.style.display = "flex";
      
      const details = document.createElement("details");
      details.className = "global-edits-dropdown";
      // Closed by default
      details.open = false;
      
      const summary = document.createElement("summary");
      summary.className = "global-edits-summary";
      const fileCount = pendingIndices.length;
      
      const summaryContent = document.createElement("div");
      summaryContent.style.display = "flex";
      summaryContent.style.alignItems = "center";
      summaryContent.style.gap = "8px";
      summaryContent.style.width = "100%";
      
      summaryContent.innerHTML = \`
        <span class="chevron" style="display: inline-block; font-size: 10px; transition: transform 0.2s;">▶</span>
        <span style="font-weight: 500; color: var(--fg); font-size: 12px;">\${fileCount} file\${fileCount > 1 ? 's' : ''} changed</span>
        <span class="diff-stats" style="font-size: 12px; margin-left: auto;">
          <span style="color: var(--vscode-charts-green, #4caf50);">+\${totalAdditions}</span>
          <span style="color: var(--vscode-charts-red, #d64545);">-\${totalDeletions}</span>
        </span>
      \`;

      const globalActions = document.createElement("div");
      globalActions.className = "global-actions";
      // Removed margin-left auto from here since we put it on diff-stats
      globalActions.style.display = "flex";
      globalActions.style.gap = "4px";

      const keepAllBtn = document.createElement("button");
      keepAllBtn.textContent = "Keep All";
      keepAllBtn.className = "tool-action-btn";
      keepAllBtn.onclick = (e) => { 
        e.preventDefault();
        vscode.postMessage({ type: "keepAllEdits" }); 
      };

      const undoAllBtn = document.createElement("button");
      undoAllBtn.textContent = "Undo All";
      undoAllBtn.className = "tool-action-btn secondary";
      undoAllBtn.onclick = (e) => { 
        e.preventDefault();
        vscode.postMessage({ type: "undoAllEdits" }); 
      };
      
      globalActions.appendChild(undoAllBtn);
      globalActions.appendChild(keepAllBtn);
      summaryContent.appendChild(globalActions);
      summary.appendChild(summaryContent);
      
      const listContainer = document.createElement("div");
      listContainer.className = "global-edits-list";
      listContainer.style.marginTop = "8px";

      for (const i of pendingIndices) {
        const m = state.messages[i];
        
        const card = document.createElement("div");
        card.className = "global-edit-card";

        const fileName = (m.fileEdit.filePath || "").split(/[\\\\/]/).pop();
        const fileIcon = '<i class="codicon codicon-file-code" style="margin-right: 6px; font-size: 16px; vertical-align: text-bottom;"></i>';
        
        const additions = m.fileEdit.additions || 0;
        const deletions = m.fileEdit.deletions || 0;
        
        const fileLabel = \`
          <div class="edit-file-name" style="flex:1;">
            <div style="font-size: 1.25em; font-weight: 500; display: inline-flex; align-items: center;">
              \${fileIcon} <span>\${fileName}</span>
            </div>
            <span class="diff-stats" style="margin-left: 8px; font-size: 11px;">
              <span style="color: var(--vscode-charts-green, #4caf50);">+\${additions}</span>
              <span style="color: var(--vscode-charts-red, #d64545);">-\${deletions}</span>
            </span>
          </div>
        \`;

        // Icons for Undo / Keep specific file
        const btnGroup = document.createElement("div");
        btnGroup.className = "hover-actions";

        const diffIconBtn = document.createElement("button");
        diffIconBtn.className = "icon-btn";
        diffIconBtn.title = "View Diff";
        diffIconBtn.innerHTML = '<i class="codicon codicon-diff-single" style="font-size: 14px;"></i>';
        diffIconBtn.onclick = (e) => {
          e.preventDefault();
          vscode.postMessage({ type: "showDiff", index: i });
        };
        
        const undoIconBtn = document.createElement("button");
        undoIconBtn.className = "icon-btn";
        undoIconBtn.title = "Undo this file";
        undoIconBtn.innerHTML = '<i class="codicon codicon-discard" style="font-size: 14px;"></i>'; 
        undoIconBtn.onclick = (e) => { 
          e.preventDefault(); 
          vscode.postMessage({ type: "undoEdit", index: i }); 
        };

        const keepIconBtn = document.createElement("button");
        keepIconBtn.className = "icon-btn";
        keepIconBtn.title = "Keep this file";
        keepIconBtn.innerHTML = '<i class="codicon codicon-check" style="font-size: 14px;"></i>';
        keepIconBtn.onclick = (e) => { 
          e.preventDefault(); 
          vscode.postMessage({ type: "keepEdit", index: i }); 
        };

        btnGroup.appendChild(diffIconBtn);
        btnGroup.appendChild(undoIconBtn);
        btnGroup.appendChild(keepIconBtn);

        card.innerHTML = fileLabel;
        
        // Add click to diff
        const fileNameEl = card.querySelector('.edit-file-name');
        if (fileNameEl) {
          fileNameEl.style.cursor = 'pointer';
          fileNameEl.title = 'View Diff';
          fileNameEl.onclick = (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'showDiff', index: i });
          };
        }

        card.appendChild(btnGroup);
        
        listContainer.appendChild(card);
      }
      
      details.appendChild(summary);
      details.appendChild(listContainer);
      container.appendChild(details);
    };

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "state") {
        state = message;
        render();
        renderGlobalPendingEdits();
      }
    });

    vscode.postMessage({ type: "ready" });
`;
