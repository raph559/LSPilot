async function testLoading() { 
    console.log('Loading model...');
    fetch('http://localhost:1234/api/v1/models/load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'qwen/qwen3.5-35b-a3b'})});
    while(true) {
        const res = await fetch('http://localhost:1234/api/v1/models');
        const data = await res.json();
        const m = data.models.find(x => x.key === 'qwen/qwen3.5-35b-a3b');
        console.log('model props:', Object.keys(m), 'instances:', m.loaded_instances.length, 'state:', JSON.stringify(m.state || m.loading || m.progress));
        if (m.loaded_instances.length > 0) break;
        await new Promise(r => setTimeout(r, 200));
    }
} testLoading();
