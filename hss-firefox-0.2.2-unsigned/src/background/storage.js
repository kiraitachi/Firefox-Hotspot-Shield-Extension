// Thin wrapper over a storage area so everything else can be tested with an
// in-memory area. In the extension the area is browser.storage.local.

export class Storage {
  constructor(area, prefix = 'hss.') {
    this.area = area;
    this.prefix = prefix;
  }

  async get(key, fallback = undefined) {
    const full = this.prefix + key;
    const found = await this.area.get(full);
    return found && full in found ? found[full] : fallback;
  }

  async set(key, value) {
    if (value === undefined) return this.remove(key);
    await this.area.set({ [this.prefix + key]: value });
  }

  async remove(key) {
    await this.area.remove(this.prefix + key);
  }
}

/** In-memory area with the same promise API as browser.storage.local (tests). */
export class MemoryArea {
  #data = {};

  async get(key) {
    return key in this.#data ? { [key]: structuredClone(this.#data[key]) } : {};
  }

  async set(obj) {
    for (const [k, v] of Object.entries(obj)) this.#data[k] = structuredClone(v);
  }

  async remove(key) {
    delete this.#data[key];
  }
}
