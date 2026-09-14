export async function saveBeforeApplicationExit(save: () => Promise<void>, exit: () => Promise<void>): Promise<void> {
  try {
    await save();
  } catch {
    // Revision conflicts and unavailable storage must never trap the user in
    // the window. The failed save remains non-destructive; exit still proceeds.
  }
  await exit();
}
