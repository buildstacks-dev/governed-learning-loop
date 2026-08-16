// Internal brand symbols. Deliberately NOT exported from any public
// entrypoint: possession of these symbols is the minting capability.
// - verifiedPrincipalBrand: only IdentityPort implementations (host-owned or
//   this repo's /testing identity port, a later PR) may construct a
//   VerifiedPrincipal, by importing this module.
// - registeredSourceBrand: RegisteredSource<I> carries a phantom input type;
//   only defineSourceRegistration produces the branded value.

export const verifiedPrincipalBrand: unique symbol = Symbol("cormidia.learning-loop/verified-principal");

export const registeredSourceBrand: unique symbol = Symbol("cormidia.learning-loop/registered-source");
