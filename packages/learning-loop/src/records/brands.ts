// Internal brand symbols. Deliberately NOT exported from any public
// entrypoint: possession of these symbols is the minting capability.
// - identityPortBrand / verifiedPrincipalBrand: phantom type markers attached
//   only by the kernel createIdentityPort factory. Runtime authority comes from
//   private per-port WeakMap bindings, not possession of these copyable symbols.
// - registeredSourceBrand: RegisteredSource<I> carries a phantom input type;
//   only defineSourceRegistration produces the branded value.

export const identityPortBrand: unique symbol = Symbol("cormidia.learning-loop/identity-port");
export const verifiedPrincipalBrand: unique symbol = Symbol("cormidia.learning-loop/verified-principal");

export const registeredSourceBrand: unique symbol = Symbol("cormidia.learning-loop/registered-source");
