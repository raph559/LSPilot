const http = require('http');

async function testLoading() {
    console.log("Starting test...");
    // 1. Unload qwen
    await fetch("http://localhost:1234/api/v1/models/unload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "qwen/qwen3.5-35b-a3b" })
    }).catch(e => console.log("unload failed", e.message));

    // 2. Start load
    console.log("Loading model...");
    const loadPromise = fetch("http://localhost:1234/api/v1/models/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "qwen/qwen3.5-35b-a3b" })
    });

    // 3. Poll
    let loading = true;
    loadPromise.then(() => loading = false);
    
    while(loading) {
        try {
            const res = await fetch("http://localhost:1234/api/v1/models");
            const data = await res.json();
            const qwen = data.models.find(m => m.key === "qwen/qwen3.5-35b-a3b");
            console.log(JSON.stringify(qwen, null, 2));
        } catch(e) {
            console.log("Polled error", e.message);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    console.log("Loading done");
}
testLoading();