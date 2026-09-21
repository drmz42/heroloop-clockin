export const shortWalletAddress = (address: string) => address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
