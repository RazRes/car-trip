import { makeHandlers } from '../lib/app.js';
import { query } from '../lib/neon.js';

export default makeHandlers(query).location;
