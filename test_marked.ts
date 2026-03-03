import { markedHighlight } from 'marked-highlight'; const ext: any = markedHighlight({ highlight: c => c }); console.log(ext.renderer.code);
