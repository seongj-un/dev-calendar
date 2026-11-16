import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles/app.css';
import './styles/import.css';
import { App } from './app/app';
import { EventStore, type StorageLike } from './store/store';

/** localStorage, or an in-memory stand-in when the browser blocks it. */
function openStorage(): { storage: StorageLike; memoryOnly: boolean } {
  try {
    const storage = window.localStorage;
    const probe = 'datebook:probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return { storage, memoryOnly: false };
  } catch {
    const map = new Map<string, string>();
    return {
      storage: {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => void map.set(key, value),
      },
      memoryOnly: true,
    };
  }
}

const root = document.getElementById('app');
if (root) {
  const { storage, memoryOnly } = openStorage();
  new App({ root, store: new EventStore(storage), prefsStorage: storage, memoryOnly });
}
