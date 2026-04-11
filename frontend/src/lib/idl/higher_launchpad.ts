/**
 * Placeholder IDL type for the higher_launchpad program.
 * Replace this file with the real generated IDL after running `anchor build`.
 * The real IDL will be at: program/target/idl/higher_launchpad.json
 */

export type HigherLaunchpad = {
  address: string;
  metadata: {
    name: "higher_launchpad";
    version: "0.1.0";
    spec: "0.1.0";
  };
  instructions: [
    {
      name: "initialize_platform";
      discriminator: number[];
      accounts: [
        { name: "platform"; writable: true; pda: { seeds: [{ kind: "const"; value: number[] }] } },
        { name: "authority"; writable: true; signer: true },
        { name: "system_program"; address: string }
      ];
      args: [{ name: "platform_fee_recipient"; type: "pubkey" }];
    },
    {
      name: "create_token";
      discriminator: number[];
      accounts: [
        { name: "token_state"; writable: true },
        { name: "mint"; writable: true; signer: true },
        { name: "mint_authority" },
        { name: "sol_vault"; writable: true },
        { name: "token_vault"; writable: true },
        { name: "metadata"; writable: true },
        { name: "platform"; writable: true },
        { name: "creator"; writable: true; signer: true },
        { name: "rent" },
        { name: "system_program" },
        { name: "token_program" },
        { name: "associated_token_program" },
        { name: "metadata_program" }
      ];
      args: [{ name: "params"; type: { defined: { name: "CreateTokenParams" } } }];
    },
    {
      name: "buy";
      discriminator: number[];
      accounts: [
        { name: "token_state"; writable: true },
        { name: "mint"; writable: true },
        { name: "sol_vault"; writable: true },
        { name: "token_vault"; writable: true },
        { name: "user_token_account"; writable: true },
        { name: "user"; writable: true; signer: true },
        { name: "fee_escrow"; writable: true },
        { name: "system_program" },
        { name: "token_program" },
        { name: "associated_token_program" }
      ];
      args: [
        { name: "sol_amount"; type: "u64" },
        { name: "min_tokens_out"; type: "u64" }
      ];
    },
    {
      name: "sell";
      discriminator: number[];
      accounts: [
        { name: "token_state"; writable: true },
        { name: "mint"; writable: true },
        { name: "sol_vault"; writable: true },
        { name: "token_vault"; writable: true },
        { name: "user_token_account"; writable: true },
        { name: "user"; writable: true; signer: true },
        { name: "fee_escrow"; writable: true },
        { name: "system_program" },
        { name: "token_program" },
        { name: "associated_token_program" }
      ];
      args: [
        { name: "token_amount"; type: "u64" },
        { name: "min_sol_out"; type: "u64" }
      ];
    },
    {
      name: "graduate";
      discriminator: number[];
      accounts: [
        { name: "token_state"; writable: true },
        { name: "mint"; writable: true },
        { name: "mint_authority"; writable: true },
        { name: "sol_vault"; writable: true },
        { name: "token_vault"; writable: true },
        { name: "platform_fee_recipient"; writable: true },
        { name: "gamm_pool_placeholder" },
        { name: "platform"; writable: true },
        { name: "caller"; writable: true; signer: true },
        { name: "system_program" },
        { name: "token_program" },
        { name: "associated_token_program" }
      ];
      args: [];
    },
    {
      name: "claim_creator_fees";
      discriminator: number[];
      accounts: [
        { name: "token_state"; writable: true },
        { name: "fee_escrow"; writable: true },
        { name: "claimer"; writable: true; signer: true },
        { name: "system_program" }
      ];
      args: [];
    }
  ];
  accounts: [
    {
      name: "PlatformState";
      discriminator: number[];
    },
    {
      name: "TokenState";
      discriminator: number[];
    }
  ];
  events: [
    { name: "TokenCreated"; discriminator: number[] },
    { name: "TradeEvent"; discriminator: number[] },
    { name: "GraduationReady"; discriminator: number[] },
    { name: "TokenGraduated"; discriminator: number[] },
    { name: "FeesClaimed"; discriminator: number[] }
  ];
  types: [
    {
      name: "CreateTokenParams";
      type: {
        kind: "struct";
        fields: [
          { name: "name"; type: "string" },
          { name: "symbol"; type: "string" },
          { name: "uri"; type: "string" },
          { name: "creator_fee_recipient"; type: "pubkey" }
        ];
      };
    },
    {
      name: "TokenPhase";
      type: {
        kind: "enum";
        variants: [
          { name: "Bonding" },
          { name: "ReadyToGraduate" },
          { name: "Graduated" }
        ];
      };
    },
    {
      name: "TradeType";
      type: {
        kind: "enum";
        variants: [{ name: "Buy" }, { name: "Sell" }];
      };
    }
  ];
};
