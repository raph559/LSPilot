async function t() {
    const res = await fetch('http://localhost:1234/api/v1/models/load', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'qwen/qwen3.5-35b-a3b'})});
    console.log(res.status, res.headers.get('content-type'));
    const text = await res.text();
    console.log(text);
} t();
