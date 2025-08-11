declare module "he" {
  const he: {
    decode: (text: string) => string;
    encode?: (text: string) => string;
  };
  export default he;
}
