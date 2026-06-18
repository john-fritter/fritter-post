// Ambient type declaration for franc-min@6 (no published @types package).
// franc-min exports { franc, francAll } as named exports.
declare module "franc-min" {
  function franc(text: string, options?: { minLength?: number }): string;
  function francAll(text: string, options?: { minLength?: number }): Array<[string, number]>;
  export { franc, francAll };
}
