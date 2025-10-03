import { bootGridFinium } from '../scripts.js';
import { detectPaperContour, extractContourPoints } from './PaperOutlining.js';

bootGridFinium({ detectPaperContour, extractContourPoints });

console.log('GridFinium MainScript: booted');
