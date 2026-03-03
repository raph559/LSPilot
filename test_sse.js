async function t() {
    const res = await fetch('http://localhost:1234/api/v1/chat', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'qwen/qwen3.5-35b-a3b',messages:[{role:'user',content:'hi'}],stream:true})});
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while(true) {
        const {value, done} = await reader.read();
        if(done) break;
        console.log('SSE Chunk:', dec.decode(value));
    }
} t();
