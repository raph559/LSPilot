async function testLoading() { 
    console.log('Loading model...');
    fetch('http://localhost:1234/api/v1/models/load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'text-embedding-nomic-embed-text-v1.5', identifier: 'nomic-1'})});
    let i=0;
    while(i < 5) {
        const res = await fetch('http://localhost:1234/api/v1/models');
        const data = await res.json();
        const m = data.models.find(x => x.key === 'text-embedding-nomic-embed-text-v1.5');
        console.log('Poll', i, 'instances:', m.loaded_instances.length);
        if (m.loaded_instances.length > 0) break;
        await new Promise(r => setTimeout(r, 50));
        i++;
    }
} testLoading();
