declare module "bs58" {
  const bs58: {
    encode(data: Uint8Array | number[] | Buffer): string;
    decode(str: string): Uint8Array;
  };
  export default bs58;
}
