// Browser audio probe substitutes extension messaging only; media/network/clocks remain real.
export const browser = { runtime: { sendMessage: async (message: unknown) => {
  (window as unknown as { probeMessages: unknown[] }).probeMessages ??= [];
  (window as unknown as { probeMessages: unknown[] }).probeMessages.push(message);
} } };
