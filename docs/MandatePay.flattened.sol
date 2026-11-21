// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// src/MandatePay.sol

/// @notice Minimal ERC-20 surface used by MandatePay (subset of EIP-20).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice EIP-2612 permit extension. tUSD8 on Aevum supports it, which lets an owner
///         fund a mandate in a single transaction (signature + create, no separate approve).
interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @title MandatePay
/// @notice Capped, expiring, revocable payment mandates for AI agents, escrowed in tUSD8.
///
/// @dev The problem: an autonomous agent that pays for APIs, data or compute needs a payment
///      credential. A raw wallet key is unlimited; a plain ERC-20 allowance is silent, has no
///      per-payment cap, no payee pinning and no expiry semantics an owner can reason about.
///
///      A *mandate* fixes that. The owner escrows a total budget into this contract once and
///      authorises exactly one agent address (a session key) to pay exactly one payee, at most
///      `perPaymentCap` per payment and `totalCap` overall, until `expiry`. The agent never
///      touches the owner's wallet. Every payment emits an event, so the mandate's history is
///      a complete on-chain audit trail. The owner can revoke at any moment and gets the
///      unspent escrow back in the same transaction; after expiry the owner settles and
///      withdraws whatever is left. Expired, exhausted or revoked mandates reject payments.
///
///      Funds are escrowed (not pulled per payment), so a payment can never fail because the
///      owner moved money or revoked a token allowance after granting the mandate — the caps
///      the owner saw at creation are the caps that hold for the mandate's whole life.
contract MandatePay {
    // ------------------------------------------------------------------ types

    enum Status {
        Active, // payments allowed (subject to expiry and caps)
        Revoked, // closed early by the owner, remainder refunded
        Settled // closed after expiry by the owner, remainder withdrawn
    }

    struct Mandate {
        address owner; // who funded the mandate and can close it
        address agent; // the only address allowed to pay (a session key)
        address payee; // the only address payments can go to
        uint256 perPaymentCap; // max amount per single payment
        uint256 totalCap; // max total across the mandate's life (= escrowed amount)
        uint256 spent; // total paid out so far
        uint64 expiry; // payments allowed while block.timestamp <= expiry
        Status status;
        string purpose; // human-readable label, e.g. "API credits — research agent"
    }

    // ------------------------------------------------------------------ events

    /// @notice Full terms of a new mandate; the audit trail starts here.
    event MandateCreated(
        uint256 indexed mandateId,
        address indexed owner,
        address indexed agent,
        address payee,
        uint256 perPaymentCap,
        uint256 totalCap,
        uint64 expiry,
        string purpose
    );

    /// @notice One executed payment. `reference` binds the payment to an off-chain
    ///         artefact (invoice id, x402 request id, order hash, ...) chosen by the agent.
    event PaymentExecuted(
        uint256 indexed mandateId, address indexed agent, address indexed payee, uint256 amount, uint256 totalSpent, bytes32 memo
    );

    /// @notice Owner closed the mandate early; `refunded` went back to the owner.
    event MandateRevoked(uint256 indexed mandateId, address indexed owner, uint256 refunded);

    /// @notice Owner withdrew the remainder after expiry.
    event MandateSettled(uint256 indexed mandateId, address indexed owner, uint256 refunded);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error ZeroAmount();
    error TotalCapBelowPerPaymentCap();
    error ExpiryNotInFuture();
    error TransferFailed();
    error NotOwner();
    error NotAgent();
    error MandateNotActive();
    error MandateExpired();
    error OverPerPaymentCap(uint256 amount, uint256 cap);
    error OverTotalCap(uint256 amount, uint256 remaining);
    error MandateNotExpired();
    error ReentrantCall();

    // ------------------------------------------------------------------ state

    /// @notice The token all mandates are denominated in (tUSD8 on Aevum).
    IERC20 public immutable token;

    /// @notice Number of mandates ever created; also the next mandate id.
    uint256 public mandateCount;

    mapping(uint256 mandateId => Mandate) private _mandates;
    mapping(address owner => uint256[]) private _mandateIdsByOwner;
    mapping(address agent => uint256[]) private _mandateIdsByAgent;

    bool private _locked;

    modifier nonReentrant() {
        if (_locked) revert ReentrantCall();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address token_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
    }

    // ------------------------------------------------------------------ create

    /// @notice Create a mandate and escrow `totalCap` of the token into this contract.
    /// @dev The caller must first `approve` this contract for at least `totalCap`
    ///      (or use {createMandateWithPermit} to do it with a signature in one call).
    /// @param agent Address of the agent / session key allowed to pay.
    /// @param payee The only address payments may go to.
    /// @param perPaymentCap Maximum amount per single payment (token base units).
    /// @param totalCap Maximum total spend; this exact amount is escrowed.
    /// @param expiry Unix timestamp after which payments stop.
    /// @param purpose Human-readable label stored on-chain for the audit trail.
    /// @return mandateId Id of the new mandate.
    function createMandate(
        address agent,
        address payee,
        uint256 perPaymentCap,
        uint256 totalCap,
        uint64 expiry,
        string calldata purpose
    ) external nonReentrant returns (uint256 mandateId) {
        mandateId = _create(agent, payee, perPaymentCap, totalCap, expiry, purpose);
        _safeTransferFrom(msg.sender, address(this), totalCap);
    }

    /// @notice Create a mandate funded by an EIP-2612 permit signature — one transaction,
    ///         no separate approve. The permit must be for exactly `totalCap` (least
    ///         privilege: the signature authorises the escrow amount and nothing more).
    /// @dev If a sufficient allowance already exists, the permit call is skipped, so a
    ///      stale signature can never brick mandate creation.
    function createMandateWithPermit(
        address agent,
        address payee,
        uint256 perPaymentCap,
        uint256 totalCap,
        uint64 expiry,
        string calldata purpose,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 mandateId) {
        if (token.allowance(msg.sender, address(this)) < totalCap) {
            IERC20Permit(address(token)).permit(msg.sender, address(this), totalCap, permitDeadline, v, r, s);
        }
        mandateId = _create(agent, payee, perPaymentCap, totalCap, expiry, purpose);
        _safeTransferFrom(msg.sender, address(this), totalCap);
    }

    function _create(
        address agent,
        address payee,
        uint256 perPaymentCap,
        uint256 totalCap,
        uint64 expiry,
        string calldata purpose
    ) internal returns (uint256 mandateId) {
        if (agent == address(0) || payee == address(0)) revert ZeroAddress();
        if (perPaymentCap == 0 || totalCap == 0) revert ZeroAmount();
        if (totalCap < perPaymentCap) revert TotalCapBelowPerPaymentCap();
        if (expiry <= block.timestamp) revert ExpiryNotInFuture();

        mandateId = mandateCount++;
        Mandate storage m = _mandates[mandateId];
        m.owner = msg.sender;
        m.agent = agent;
        m.payee = payee;
        m.perPaymentCap = perPaymentCap;
        m.totalCap = totalCap;
        m.expiry = expiry;
        m.status = Status.Active;
        m.purpose = purpose;

        _mandateIdsByOwner[msg.sender].push(mandateId);
        _mandateIdsByAgent[agent].push(mandateId);

        emit MandateCreated(mandateId, msg.sender, agent, payee, perPaymentCap, totalCap, expiry, purpose);
    }

    // ------------------------------------------------------------------ pay

    /// @notice Pay the mandate's payee from escrow. Only the mandate's agent may call.
    /// @param mandateId The mandate to spend from.
    /// @param amount Payment amount (token base units), within both caps.
    /// @param memo Off-chain binding chosen by the agent (invoice / request id hash).
    function pay(uint256 mandateId, uint256 amount, bytes32 memo) external nonReentrant {
        Mandate storage m = _mandates[mandateId];
        if (msg.sender != m.agent) revert NotAgent();
        if (m.status != Status.Active) revert MandateNotActive();
        if (block.timestamp > m.expiry) revert MandateExpired();
        if (amount == 0) revert ZeroAmount();
        if (amount > m.perPaymentCap) revert OverPerPaymentCap(amount, m.perPaymentCap);
        uint256 remaining = m.totalCap - m.spent;
        if (amount > remaining) revert OverTotalCap(amount, remaining);

        // Effects before interaction; the escrow balance always covers `remaining`.
        m.spent += amount;
        emit PaymentExecuted(mandateId, msg.sender, m.payee, amount, m.spent, memo);
        _safeTransfer(m.payee, amount);
    }

    // ------------------------------------------------------------------ close

    /// @notice Revoke a mandate immediately and refund the unspent escrow to the owner.
    ///         Works at any time while the mandate is active — this is the kill switch if
    ///         an agent key is compromised or an agent misbehaves.
    function revoke(uint256 mandateId) external nonReentrant {
        Mandate storage m = _mandates[mandateId];
        if (msg.sender != m.owner) revert NotOwner();
        if (m.status != Status.Active) revert MandateNotActive();

        m.status = Status.Revoked;
        uint256 refund = m.totalCap - m.spent;
        emit MandateRevoked(mandateId, msg.sender, refund);
        if (refund > 0) _safeTransfer(msg.sender, refund);
    }

    /// @notice After expiry, withdraw the unspent escrow and close the mandate.
    function settleExpired(uint256 mandateId) external nonReentrant {
        Mandate storage m = _mandates[mandateId];
        if (msg.sender != m.owner) revert NotOwner();
        if (m.status != Status.Active) revert MandateNotActive();
        if (block.timestamp <= m.expiry) revert MandateNotExpired();

        m.status = Status.Settled;
        uint256 refund = m.totalCap - m.spent;
        emit MandateSettled(mandateId, msg.sender, refund);
        if (refund > 0) _safeTransfer(msg.sender, refund);
    }

    // ------------------------------------------------------------------ views

    /// @notice Full mandate record by id.
    function getMandate(uint256 mandateId) external view returns (Mandate memory) {
        return _mandates[mandateId];
    }

    /// @notice Unspent escrow remaining under a mandate.
    function remainingOf(uint256 mandateId) external view returns (uint256) {
        Mandate storage m = _mandates[mandateId];
        return m.totalCap - m.spent;
    }

    /// @notice Effective status: an active mandate past its expiry reports as expired
    ///         even before the owner settles it. Returns 0=Active, 1=Expired,
    ///         2=Revoked, 3=Settled.
    function statusOf(uint256 mandateId) external view returns (uint8) {
        Mandate storage m = _mandates[mandateId];
        if (m.status == Status.Revoked) return 2;
        if (m.status == Status.Settled) return 3;
        if (block.timestamp > m.expiry) return 1;
        return 0;
    }

    /// @notice Whether `amount` could be paid right now under this mandate.
    ///         Agents should call this before paying to fail cheap and explain why.
    function canPay(uint256 mandateId, uint256 amount) external view returns (bool ok, string memory reason) {
        Mandate storage m = _mandates[mandateId];
        if (m.status != Status.Active) return (false, "mandate is not active");
        if (block.timestamp > m.expiry) return (false, "mandate has expired");
        if (amount == 0) return (false, "amount is zero");
        if (amount > m.perPaymentCap) return (false, "amount exceeds the per-payment cap");
        if (amount > m.totalCap - m.spent) return (false, "amount exceeds the remaining budget");
        return (true, "");
    }

    /// @notice Mandate ids created by an owner (for UIs and indexers).
    function mandateIdsOfOwner(address owner) external view returns (uint256[] memory) {
        return _mandateIdsByOwner[owner];
    }

    /// @notice Mandate ids an agent is authorised under.
    function mandateIdsOfAgent(address agent) external view returns (uint256[] memory) {
        return _mandateIdsByAgent[agent];
    }

    // ------------------------------------------------------------------ token helpers

    /// @dev SafeERC20-style calls: accept tokens that return bool and tokens that return
    ///      nothing; revert on failure or a false return. tUSD8 returns bool.
    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

