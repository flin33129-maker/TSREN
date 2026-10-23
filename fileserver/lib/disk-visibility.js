const fs = require('fs');
const path = require('path');
class DiskVisibility {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'disk-visibility.json');
    this.data = { version: 1, hidden: {} };
    this.load();
  }
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j === 'object' && j.hidden) this.data = j;
    } catch (e) {}
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
  isHidden(id) { return !!(this.data.hidden && this.data.hidden[id]); }
  listHidden() { return Object.keys(this.data.hidden || {}); }
  set(id, hidden, by) {
    if (!this.data.hidden) this.data.hidden = {};
    if (hidden) this.data.hidden[id] = { by: by || 'system', at: new Date().toISOString() };
    else delete this.data.hidden[id];
    this.save();
    return this.isHidden(id);
  }
}
module.exports = { DiskVisibility };
