const DATABASE_NAME = "secure-send-host-keys";
const STORE_NAME = "keys";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open host key storage."));
  });
}

export async function saveHostPrivateKey(roomId: string, key: CryptoKey): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(key, roomId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save host key."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not save host key."));
  });
  database.close();
}

export async function loadHostPrivateKey(roomId: string): Promise<CryptoKey | null> {
  const database = await openDatabase();
  const key = await new Promise<CryptoKey | null>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(roomId);
    request.onsuccess = () => resolve((request.result as CryptoKey | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not load host key."));
  });
  database.close();
  return key;
}

export async function deleteHostPrivateKey(roomId: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(roomId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove host key."));
  });
  database.close();
}
