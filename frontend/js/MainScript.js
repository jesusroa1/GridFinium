import { bootGridFinium } from '../scripts.js';
import { detectPaperContour, extractContourPoints } from './PaperOutlining.js';
import { ensureThreeJs, initStlDesigner } from './STLLogic.js';

bootGridFinium({ detectPaperContour, extractContourPoints });

const stlDesignerOptions = {
  viewerId: 'stl-viewer',
  widthInputId: 'stl-width',
  depthInputId: 'stl-depth',
  heightInputId: 'stl-height',
  summaryId: 'stl-summary',
  downloadButtonId: 'stl-download',
  resetButtonId: 'stl-reset',
};

ensureThreeJs().finally(() => {
  initStlDesigner(stlDesignerOptions);
});

console.log('GridFinium MainScript: booted');
