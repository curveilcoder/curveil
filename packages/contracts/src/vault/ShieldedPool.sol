// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT5} from "poseidon-solidity/PoseidonT5.sol";
import {AssetRegistry} from "../shared/AssetRegistry.sol";
import {TransferHelper} from "../shared/TransferHelper.sol";
import {IGroth16Verifier9} from "./interfaces/IGroth16Verifier9.sol";
import {IShieldedAdapter} from "./interfaces/IShieldedAdapter.sol";

/// @title ShieldedPool
/// @notice Curveil's shielded vault (whitepaper sections 7 and 14). Holds admitted ERC-20s
///         against private notes. A note is a Poseidon commitment in an append-only Merkle
///         tree; spending it publishes a nullifier that can never be used again.
/// @dev The construction is fixed in docs/vault-spec.md. Summary:
///        ownerHash  = Poseidon2(ownerKey, blinding)                         (made by the client)
///        commitment = Poseidon4(resource, amount, ownerHash, noteDomain)
///        nullifier  = Poseidon3(spendingKey, commitment, leafIndex)          (inside proofs)
///      Shielding builds the commitment on-chain from the amount actually received, so
///      deposits need no proof. Transfers and withdrawals carry a Groth16 proof whose public
///      inputs include a context hash binding chain, contract, recipients, fees, deadline and
///      the published ciphertexts. Verifiers are immutable: a circuit change ships as a new
///      pool, and the old pool keeps honouring exits.
///      Version 2 adds `execute`: up to two spend legs (each proved with the withdraw circuit
///      under the execute context) fund an approved market adapter, and the adapter's outputs
///      become notes whose amounts are set on-chain, or public payouts.
contract ShieldedPool is Ownable2Step, ReentrancyGuard {
    uint256 public constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant LEVELS = 24;
    uint32 public constant ROOT_HISTORY = 100;
    uint256 public constant MAX_AMOUNT = type(uint128).max;
    uint256 public constant NOTE_CIPHERTEXT_LENGTH = 129;
    uint16 public constant MAX_WITHDRAW_FEE_BPS = 100;
    /// A spending pause ends on its own after this long, and a new one cannot start until
    /// `SPEND_PAUSE_GAP` after the last one ended, so no pause can trap funds for good.
    uint256 public constant MAX_SPEND_PAUSE = 72 hours;
    uint256 public constant SPEND_PAUSE_GAP = 24 hours;
    uint256 public constant VERSION = 2;
    uint8 public constant NOTE_VERSION = 1;
    uint8 public constant OPEN_AMOUNT_NOTE_VERSION = 2;
    uint256 public constant MAX_LEGS = 2;
    uint256 public constant MAX_OUTPUTS = 4;

    bytes32 public constant TRANSFER_TAG = keccak256("curveil.vault.transfer.v1");
    bytes32 public constant WITHDRAW_TAG = keccak256("curveil.vault.withdraw.v1");
    bytes32 public constant RESOURCE_FUNGIBLE_TAG = keccak256("curveil.resource.fungible.v1");
    bytes32 public constant NOTE_DOMAIN_TAG = keccak256("curveil.note.v1");
    bytes32 public constant EXECUTE_TAG = keccak256("curveil.vault.execute.v1");
    bytes32 public constant RESOURCE_SHARE_TAG = keccak256("curveil.resource.share.v1");

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    struct TransferArgs {
        uint256 root;
        uint256[2] nullifiers;
        uint256[2] commitments;
        uint256 fee;
        uint256 feeResource;
        address feeRecipient;
        uint256 deadline;
        bytes encryptedNote0;
        bytes encryptedNote1;
    }

    struct WithdrawArgs {
        uint256 root;
        uint256[2] nullifiers;
        uint256 commitment;
        address token;
        uint256 amount;
        uint256 fee;
        address recipient;
        address feeRecipient;
        uint256 deadline;
        bytes encryptedChange;
    }

    /// @notice One spend inside `execute`: up to two notes of one resource, proved with the
    ///         withdraw circuit under the execute context. `amount` goes to the adapter, `fee`
    ///         to the fee recipient, and `change` is the change note.
    struct Leg {
        Proof proof;
        uint256 root;
        uint256[2] nullifiers;
        uint256 resource;
        uint256 amount;
        uint256 fee;
        uint256 change;
        bytes encryptedChange;
    }

    /// @notice Where one adapter output goes. With no recipient it becomes a note for
    ///         `ownerHash` whose amount is set on-chain (ciphertext version 2). With a recipient
    ///         it is paid out publicly and pays the withdrawal fee. `fee` is taken from the
    ///         output for the fee recipient.
    struct OutputSpec {
        uint256 ownerHash;
        address recipient;
        uint256 fee;
        bytes encryptedNote;
    }

    struct ExecuteArgs {
        address adapter;
        bytes params;
        Leg[] legs;
        OutputSpec[] outputs;
        address feeRecipient;
        uint256 deadline;
    }

    /// @dev ExitOnly accepts actions that spend only the adapter's own shares, so new risk can
    ///      be stopped without blocking exits. An adapter that was enabled can never go back to None.
    enum AdapterStatus {
        None,
        Active,
        ExitOnly
    }

    struct ShareInfo {
        address adapter;
        uint256 shareId;
    }

    struct AssetConfig {
        bool shieldingEnabled;
        uint128 maxDeposit;
        uint256 resource;
    }

    IGroth16Verifier9 public immutable transferVerifier;
    IGroth16Verifier9 public immutable withdrawVerifier;
    AssetRegistry public immutable registry;
    uint256 public immutable noteDomain;

    uint256[LEVELS] private _filledSubtrees;
    uint256[ROOT_HISTORY] private _roots;
    uint32 public currentRootIndex;
    uint32 public nextLeafIndex;

    mapping(uint256 nullifier => bool) public nullifierSpent;
    mapping(address token => AssetConfig) private _assets;
    mapping(uint256 resource => address token) public tokenOfResource;
    /// @notice Value the pool owes to note holders, per token. Deposits add; withdrawals and
    ///         public fees subtract. The token balance always covers it plus accrued fees.
    mapping(address token => uint256) public shieldedBalance;
    mapping(address token => uint256) public protocolFeesAccrued;
    mapping(address adapter => AdapterStatus) public adapterStatus;
    /// @notice Which adapter issued a share resource, and its id there.
    mapping(uint256 resource => ShareInfo) public shareOf;

    uint16 public withdrawFeeBps;
    address public protocolFeeRecipient;
    address public guardian;
    bool public shieldPaused;
    /// @notice Spending (transfers, withdrawals, executions) is paused until this time.
    uint64 public spendPausedUntil;

    event NoteCommitted(uint256 indexed leafIndex, uint256 commitment, bytes encryptedNote);
    event NullifierSpent(uint256 indexed nullifier);
    event Shielded(address indexed depositor, address indexed token, uint256 amount, uint256 indexed leafIndex);
    event Transferred(uint256 nullifier0, uint256 nullifier1, address feeToken, uint256 fee, address feeRecipient);
    event Withdrawn(
        address indexed recipient,
        address indexed token,
        uint256 amount,
        uint256 protocolFee,
        uint256 fee,
        address feeRecipient
    );
    event ProtocolFeesClaimed(address indexed token, address indexed recipient, uint256 amount);
    event AssetConfigured(address indexed token, uint256 resource, bool shieldingEnabled, uint128 maxDeposit);
    event WithdrawFeeSet(uint16 bps);
    event ProtocolFeeRecipientSet(address recipient);
    event GuardianSet(address guardian);
    event PauseSet(bool shieldPaused, bool spendPaused);
    event AdapterSet(address indexed adapter, AdapterStatus status);
    event ShareRegistered(uint256 indexed resource, address indexed adapter, uint256 shareId);
    event LegSpent(address indexed adapter, address indexed token, uint256 resource, uint256 amount, uint256 fee);
    event OutputSettled(
        address indexed adapter,
        uint256 index,
        address token,
        uint256 shareId,
        uint256 amount,
        uint256 fee,
        address recipient,
        uint256 protocolFee,
        uint256 leafIndex
    );
    event Executed(address indexed adapter, uint256 legs, uint256 outputs, address feeRecipient);

    error ZeroAddress();
    error ShieldingPaused();
    error SpendingPaused();
    error NotGuardian();
    error AssetNotShieldable(address token);
    error UnknownAsset(address token);
    error UnknownResource(uint256 resource);
    error BadAmount();
    error DepositAboveCap(uint256 cap);
    error NotAFieldElement();
    error PauseGap(uint256 until);
    error BadCiphertext();
    error Expired();
    error UnknownRoot();
    error NullifierAlreadySpent(uint256 nullifier);
    error DuplicateNullifier();
    error BadFeeTerms();
    error InvalidProof();
    error FeeTooHigh();
    error TreeFull();
    error NothingToClaim();
    error AdapterNotEnabled(address adapter);
    error AdapterExitOnly(address adapter);
    error CannotDisableAdapter();
    error BadShape();
    error NotAdapterShare(uint256 resource);
    error OutputMismatch();
    error BadOutput(uint256 index);
    error FeeExceedsOutput(uint256 index);
    error Undercollateralised(address token);

    constructor(
        address initialOwner,
        AssetRegistry registry_,
        IGroth16Verifier9 transferVerifier_,
        IGroth16Verifier9 withdrawVerifier_,
        uint16 withdrawFeeBps_,
        address protocolFeeRecipient_
    ) Ownable(initialOwner) {
        if (
            address(registry_) == address(0) || address(transferVerifier_) == address(0)
                || address(withdrawVerifier_) == address(0)
        ) revert ZeroAddress();
        if (withdrawFeeBps_ > MAX_WITHDRAW_FEE_BPS) revert FeeTooHigh();
        registry = registry_;
        transferVerifier = transferVerifier_;
        withdrawVerifier = withdrawVerifier_;
        noteDomain = uint256(keccak256(abi.encode(NOTE_DOMAIN_TAG, block.chainid, address(this)))) % FIELD_SIZE;
        withdrawFeeBps = withdrawFeeBps_;
        protocolFeeRecipient = protocolFeeRecipient_;
        for (uint256 i = 0; i < LEVELS; i++) {
            _filledSubtrees[i] = zeros(i);
        }
        _roots[0] = zeros(LEVELS);
    }

    // ---------------------------------------------------------------- user actions

    /// @notice Deposits `amount` of `token` as a new note. The depositor, token, amount and
    ///         time are public; the note's owner is hidden inside `ownerHash`.
    /// @param ownerHash Poseidon2(ownerKey, blinding), computed by the client.
    /// @param encryptedNote The note's ciphertext for the owner's viewing key (129 bytes).
    function shield(address token, uint256 amount, uint256 ownerHash, bytes calldata encryptedNote)
        external
        nonReentrant
        returns (uint32 leafIndex)
    {
        if (shieldPaused) revert ShieldingPaused();
        AssetConfig memory cfg = _assets[token];
        if (!cfg.shieldingEnabled || !registry.isAdmitted(token)) revert AssetNotShieldable(token);
        if (amount == 0 || amount > MAX_AMOUNT) revert BadAmount();
        if (cfg.maxDeposit != 0 && amount > cfg.maxDeposit) revert DepositAboveCap(cfg.maxDeposit);
        if (ownerHash >= FIELD_SIZE) revert NotAFieldElement();
        _checkCiphertext(encryptedNote, NOTE_VERSION);

        // Fee-on-transfer and rebasing tokens revert here instead of under-backing notes.
        TransferHelper.pullExact(IERC20(token), msg.sender, amount);
        shieldedBalance[token] += amount;

        uint256 commitment = PoseidonT5.hash([cfg.resource, amount, ownerHash, noteDomain]);
        leafIndex = _insert(commitment);
        emit NoteCommitted(leafIndex, commitment, encryptedNote);
        emit Shielded(msg.sender, token, amount, leafIndex);
    }

    /// @notice Private transfer: spends up to two notes, creates a recipient note and a change
    ///         note. Anyone may submit; the fee and its recipient are fixed by the proof.
    function transfer(Proof calldata proof, TransferArgs calldata a) external nonReentrant {
        if (spendPaused()) revert SpendingPaused();
        if (block.timestamp > a.deadline) revert Expired();
        if (!isKnownRoot(a.root)) revert UnknownRoot();
        if (a.fee > MAX_AMOUNT) revert BadAmount();
        address feeToken;
        if (a.fee == 0) {
            // No fee: nothing about the asset becomes public.
            if (a.feeResource != 0 || a.feeRecipient != address(0)) revert BadFeeTerms();
        } else {
            feeToken = tokenOfResource[a.feeResource];
            if (feeToken == address(0)) revert UnknownResource(a.feeResource);
            if (a.feeRecipient == address(0)) revert BadFeeTerms();
        }
        _checkCommitment(a.commitments[0]);
        _checkCommitment(a.commitments[1]);
        _checkCiphertext(a.encryptedNote0, NOTE_VERSION);
        _checkCiphertext(a.encryptedNote1, NOTE_VERSION);

        uint256 context = uint256(
            keccak256(
                abi.encode(
                    TRANSFER_TAG,
                    block.chainid,
                    address(this),
                    a.feeRecipient,
                    a.fee,
                    a.feeResource,
                    a.deadline,
                    keccak256(a.encryptedNote0),
                    keccak256(a.encryptedNote1)
                )
            )
        ) % FIELD_SIZE;
        uint256[9] memory pub = [
            a.root,
            noteDomain,
            context,
            a.fee,
            a.feeResource,
            a.nullifiers[0],
            a.nullifiers[1],
            a.commitments[0],
            a.commitments[1]
        ];
        if (!transferVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) revert InvalidProof();

        _spend(a.nullifiers);
        uint32 i0 = _insert(a.commitments[0]);
        emit NoteCommitted(i0, a.commitments[0], a.encryptedNote0);
        uint32 i1 = _insert(a.commitments[1]);
        emit NoteCommitted(i1, a.commitments[1], a.encryptedNote1);

        if (a.fee != 0) {
            shieldedBalance[feeToken] -= a.fee;
            TransferHelper.push(IERC20(feeToken), a.feeRecipient, a.fee);
        }
        emit Transferred(a.nullifiers[0], a.nullifiers[1], feeToken, a.fee, a.feeRecipient);
    }

    /// @notice Withdrawal: spends up to two notes and releases `amount` of `token` to a public
    ///         recipient, minus the protocol withdrawal fee; a broadcaster fee may also be paid.
    ///         Recipient, token, amount and time become public. Works even after an asset is
    ///         suspended or shielding is disabled for it.
    function withdraw(Proof calldata proof, WithdrawArgs calldata a) external nonReentrant {
        if (spendPaused()) revert SpendingPaused();
        if (block.timestamp > a.deadline) revert Expired();
        if (!isKnownRoot(a.root)) revert UnknownRoot();
        uint256 resource = _assets[a.token].resource;
        if (resource == 0) revert UnknownAsset(a.token);
        if (a.amount == 0 || a.amount > MAX_AMOUNT || a.fee > MAX_AMOUNT) revert BadAmount();
        if (a.recipient == address(0)) revert ZeroAddress();
        if ((a.fee == 0) != (a.feeRecipient == address(0))) revert BadFeeTerms();
        _checkCommitment(a.commitment);
        _checkCiphertext(a.encryptedChange, NOTE_VERSION);

        uint16 bps = withdrawFeeBps;
        uint256 context = uint256(
            keccak256(
                abi.encode(
                    WITHDRAW_TAG,
                    block.chainid,
                    address(this),
                    a.token,
                    a.recipient,
                    a.feeRecipient,
                    a.fee,
                    uint256(bps),
                    a.deadline,
                    keccak256(a.encryptedChange)
                )
            )
        ) % FIELD_SIZE;
        uint256[9] memory pub =
            [a.root, noteDomain, context, resource, a.amount, a.fee, a.nullifiers[0], a.nullifiers[1], a.commitment];
        if (!withdrawVerifier.verifyProof(proof.a, proof.b, proof.c, pub)) revert InvalidProof();

        _spend(a.nullifiers);
        uint32 idx = _insert(a.commitment);
        emit NoteCommitted(idx, a.commitment, a.encryptedChange);

        // Rounded up, in the protocol's favour. The fee is bound into the proof via `bps`.
        uint256 protocolFee = (a.amount * bps + 9999) / 10000;
        shieldedBalance[a.token] -= a.amount + a.fee;
        protocolFeesAccrued[a.token] += protocolFee;
        TransferHelper.push(IERC20(a.token), a.recipient, a.amount - protocolFee);
        if (a.fee != 0) TransferHelper.push(IERC20(a.token), a.feeRecipient, a.fee);
        emit Withdrawn(a.recipient, a.token, a.amount, protocolFee, a.fee, a.feeRecipient);
    }

    /// @notice Shielded execution: spends up to two legs into an approved adapter (a swap, a
    ///         liquidity entry or exit) and settles the adapter's outputs as new notes or public
    ///         payouts, atomically. If anything fails, the whole call reverts and every input note
    ///         stays unspent. Amounts sent to and returned by the adapter are public; who owns the
    ///         inputs and the output notes is not.
    function execute(ExecuteArgs calldata a) external nonReentrant {
        if (spendPaused()) revert SpendingPaused();
        if (block.timestamp > a.deadline) revert Expired();
        AdapterStatus status = adapterStatus[a.adapter];
        if (status == AdapterStatus.None) revert AdapterNotEnabled(a.adapter);
        uint256 nLegs = a.legs.length;
        uint256 nOut = a.outputs.length;
        if (nLegs == 0 || nLegs > MAX_LEGS || nOut > MAX_OUTPUTS) revert BadShape();

        uint256 context = executeContext(a);
        bool anyFee;
        bool fungibleIn;
        IShieldedAdapter.Input[] memory inputs = new IShieldedAdapter.Input[](nLegs);
        for (uint256 i = 0; i < nLegs; i++) {
            inputs[i] = _spendLeg(a.legs[i], a.adapter, a.feeRecipient, context);
            if (inputs[i].token != address(0)) {
                if (status == AdapterStatus.ExitOnly) revert AdapterExitOnly(a.adapter);
                fungibleIn = true;
            }
            anyFee = anyFee || a.legs[i].fee != 0;
        }

        IShieldedAdapter.Output[] memory outs = IShieldedAdapter(a.adapter).execute(a.params, inputs);
        if (outs.length != nOut) revert OutputMismatch();
        for (uint256 j = 0; j < nOut; j++) {
            _settleOutput(a, j, outs[j], fungibleIn);
            anyFee = anyFee || a.outputs[j].fee != 0;
        }
        // One canonical form: a fee recipient is named exactly when some fee is paid.
        if (anyFee != (a.feeRecipient != address(0))) revert BadFeeTerms();
        // The adapter must have delivered every fungible output it reported.
        for (uint256 j = 0; j < nOut; j++) {
            if (outs[j].token != address(0)) _checkBacking(outs[j].token);
        }
        emit Executed(a.adapter, nLegs, nOut, a.feeRecipient);
    }

    /// @notice The context hash every leg of `a` must prove against. Binds the chain, this pool,
    ///         the adapter and its parameters, every leg (root, resource, amount, fee, nullifiers,
    ///         change and its ciphertext), every output (owner, recipient, fee, ciphertext), the
    ///         fee recipient, the withdrawal fee rate and the deadline. Each leg's proof therefore
    ///         commits to the whole action, so no leg can be dropped, swapped or reused.
    function executeContext(ExecuteArgs calldata a) public view returns (uint256) {
        bytes memory legs;
        for (uint256 i = 0; i < a.legs.length; i++) {
            legs = abi.encodePacked(legs, _legHash(a.legs[i]));
        }
        bytes memory outs;
        for (uint256 j = 0; j < a.outputs.length; j++) {
            OutputSpec calldata o = a.outputs[j];
            outs = abi.encodePacked(outs, keccak256(abi.encode(o.ownerHash, o.recipient, o.fee, keccak256(o.encryptedNote))));
        }
        return uint256(
            keccak256(
                abi.encode(
                    EXECUTE_TAG,
                    block.chainid,
                    address(this),
                    a.adapter,
                    keccak256(a.params),
                    keccak256(legs),
                    keccak256(outs),
                    a.feeRecipient,
                    uint256(withdrawFeeBps),
                    a.deadline
                )
            )
        ) % FIELD_SIZE;
    }

    /// @notice Sends accrued withdrawal fees to the protocol fee recipient. Callable by anyone.
    function claimProtocolFees(address token) external nonReentrant returns (uint256 amount) {
        address to = protocolFeeRecipient;
        if (to == address(0)) revert ZeroAddress();
        amount = protocolFeesAccrued[token];
        if (amount == 0) revert NothingToClaim();
        protocolFeesAccrued[token] = 0;
        TransferHelper.push(IERC20(token), to, amount);
        emit ProtocolFeesClaimed(token, to, amount);
    }

    // ---------------------------------------------------------------- views

    function getLastRoot() external view returns (uint256) {
        return _roots[currentRootIndex];
    }

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 i = currentRootIndex;
        for (uint32 n = 0; n < ROOT_HISTORY; n++) {
            if (_roots[i] == root) return true;
            i = i == 0 ? ROOT_HISTORY - 1 : i - 1;
        }
        return false;
    }

    function assetConfig(address token) external view returns (AssetConfig memory) {
        return _assets[token];
    }

    function resourceOf(address token) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(RESOURCE_FUNGIBLE_TAG, token))) % FIELD_SIZE;
    }

    /// @notice Resource of a share issued by `adapter`: shares of different adapters, or of
    ///         different positions, can never be spent as each other or as a token.
    function shareResource(address adapter, uint256 shareId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(RESOURCE_SHARE_TAG, adapter, shareId))) % FIELD_SIZE;
    }

    /// @notice Empty-subtree values: zeros(0) = keccak256("curveil.vault.zero") mod p,
    ///         zeros(i + 1) = Poseidon2(zeros(i), zeros(i)). Checked against Poseidon in tests.
    function zeros(uint256 i) public pure returns (uint256) {
        if (i == 0) return 0x014fb93505c71cbe71e60f9a5d94c72cbbb175c6dff965413189a1cdbbef160e;
        if (i == 1) return 0x0e2a134af5f0283097ee59ac87e7ffced4dbef75b612b3e3a552faedee207dfd;
        if (i == 2) return 0x19c965fb8cb44a1ccddf45e66af3585c27b15b3dc1ea1824798496cf5121f51e;
        if (i == 3) return 0x1a85e44a8317c16398f316b088a4ebe974b0f4da2c9acca5aa97dd71fc90851b;
        if (i == 4) return 0x23725e1d9ba8a995b97fb176b189d03472325863ca39147d6075f8855d5559eb;
        if (i == 5) return 0x11791fe7e9609613d9da501353a2e968eac3f81fab76009b38b6b1fc3fcda326;
        if (i == 6) return 0x174f666e4c322771adb95a1fbdb893bbba059ea44f18749f256b50a6abcec108;
        if (i == 7) return 0x0794bd0d331a279e85f9d5d8a2881e5820bff6cbd137818b2d5950fa96c9ee86;
        if (i == 8) return 0x1c84ecea6139016ec48a52d45c810b490cf385a1bcd303e02ce322b2974bf37c;
        if (i == 9) return 0x0583e312be39a7e33216d156d941f13dc9fd689dba56bd08cb975efae2ec85be;
        if (i == 10) return 0x12f76db466cc24c64f27d53d80851acb50b58fcd5f065dbf1ca74357a7c5d24b;
        if (i == 11) return 0x265370a66d45f0e1c7c4f9df3781ede1a7eac17ffae18c24d7951ca816ad71ca;
        if (i == 12) return 0x2f6b1824590961b02ccd3c5e8ab8dd8eb65c9e3b682411cca76e6e7f932c0d47;
        if (i == 13) return 0x064ec89ab57be718fad94ec94217fc1737e30ff6ae283acd64d364e874a450c4;
        if (i == 14) return 0x0d738221278bb789b21245815c974d27e0cd19ffed9b1162dabd3754010001cf;
        if (i == 15) return 0x2f6997614a3dcdfe7e242c71006b4ead33b343ac2b0ed8d118d43ffc9b615756;
        if (i == 16) return 0x02349793d3e8b2a6f0155f340df46ec310ee80c6a0cf8e93abc662c138e3f3f9;
        if (i == 17) return 0x1706bc5a0b5c96f9e298e9795f6be95a823e14d5437a6d1ddf210730409d2f71;
        if (i == 18) return 0x082bc8a09ad05258653a1d12535a488ec0202c6b2cb7c17d17c2cfebf48b3727;
        if (i == 19) return 0x13b2b3868064d1600ceaabedd61300c522f7a11f3c5e142688a992154f990ab0;
        if (i == 20) return 0x238074eeaa9849d44bea8b454d09e30609bad86d23fdde840d0c3da5a25807f9;
        if (i == 21) return 0x21727b4c5814dbff0c0bc012db0ed3410ae83722475d10f3191c188811864166;
        if (i == 22) return 0x2fdcc0150885c313ee78f21f15dff8876054b2ed2cf4fcd5e7396c30e1dd0738;
        if (i == 23) return 0x217c81f13323c86846563772b5d094a550bee4be391942d4ec007a2f4a3cb5fd;
        if (i == 24) return 0x19627d09a3eca319b211045f22beabcc89d63a8250fa5f95f6a1e482f985a929;
        revert TreeFull();
    }

    // ---------------------------------------------------------------- admin

    /// @notice Enables or disables shielding of an admitted token and sets its per-deposit
    ///         cap (0 = no cap). Disabling never blocks transfers or withdrawals.
    function configureAsset(address token, bool shieldingEnabled, uint128 maxDeposit) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (shieldingEnabled && !registry.isAdmitted(token)) revert AssetNotShieldable(token);
        uint256 resource = resourceOf(token);
        if (resource == 0) revert UnknownResource(0);
        tokenOfResource[resource] = token;
        _assets[token] = AssetConfig(shieldingEnabled, maxDeposit, resource);
        emit AssetConfigured(token, resource, shieldingEnabled, maxDeposit);
    }

    /// @notice New fee applies only to proofs made after the change: the fee rate is part of
    ///         every withdrawal's context hash, so older proofs fail rather than pay more.
    function setWithdrawFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_WITHDRAW_FEE_BPS) revert FeeTooHigh();
        withdrawFeeBps = bps;
        emit WithdrawFeeSet(bps);
    }

    function setProtocolFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        protocolFeeRecipient = recipient;
        emit ProtocolFeeRecipientSet(recipient);
    }

    /// @notice Enables an adapter, or limits it to exits. Once enabled, an adapter can never be
    ///         fully disabled, so positions it issued can always be exited.
    function setAdapter(address adapter, AdapterStatus status) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        if (status == AdapterStatus.None && adapterStatus[adapter] != AdapterStatus.None) revert CannotDisableAdapter();
        adapterStatus[adapter] = status;
        emit AdapterSet(adapter, status);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice The guardian (or owner) can pause; only the owner can unpause early.
    ///         A shielding pause stops new deposits and lasts until the owner lifts it. A
    ///         spending pause also stops exits, so it lasts at most `MAX_SPEND_PAUSE`, cannot
    ///         be extended, and cannot start again until `SPEND_PAUSE_GAP` after it ended.
    function pause(bool shielding, bool spending) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        if (shielding) shieldPaused = true;
        if (spending && !spendPaused()) {
            uint256 last = spendPausedUntil;
            if (last != 0 && block.timestamp < last + SPEND_PAUSE_GAP) revert PauseGap(last + SPEND_PAUSE_GAP);
            spendPausedUntil = uint64(block.timestamp + MAX_SPEND_PAUSE);
        }
        emit PauseSet(shieldPaused, spendPaused());
    }

    /// @dev Ending a spending pause early still starts the gap, so an unpause cannot be used
    ///      to chain pauses back to back.
    function unpause(bool shielding, bool spending) external onlyOwner {
        if (shielding) shieldPaused = false;
        if (spending && spendPaused()) spendPausedUntil = uint64(block.timestamp);
        emit PauseSet(shieldPaused, spendPaused());
    }

    function spendPaused() public view returns (bool) {
        return block.timestamp < spendPausedUntil;
    }

    // ---------------------------------------------------------------- internals

    function _checkCommitment(uint256 c) private pure {
        if (c >= FIELD_SIZE) revert NotAFieldElement();
    }

    function _checkCiphertext(bytes calldata ct, uint8 version) private pure {
        if (ct.length != NOTE_CIPHERTEXT_LENGTH || uint8(ct[0]) != version) revert BadCiphertext();
    }

    function _legHash(Leg calldata l) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                l.root,
                l.resource,
                l.amount,
                l.fee,
                l.nullifiers[0],
                l.nullifiers[1],
                l.change,
                keccak256(l.encryptedChange)
            )
        );
    }

    function _spendLeg(Leg calldata l, address adapter, address feeRecipient, uint256 context)
        private
        returns (IShieldedAdapter.Input memory input)
    {
        if (!isKnownRoot(l.root)) revert UnknownRoot();
        if (l.amount == 0 || l.amount > MAX_AMOUNT || l.fee > MAX_AMOUNT) revert BadAmount();
        _checkCommitment(l.change);
        _checkCiphertext(l.encryptedChange, NOTE_VERSION);
        uint256[9] memory pub =
            [l.root, noteDomain, context, l.resource, l.amount, l.fee, l.nullifiers[0], l.nullifiers[1], l.change];
        if (!withdrawVerifier.verifyProof(l.proof.a, l.proof.b, l.proof.c, pub)) revert InvalidProof();

        _spend(l.nullifiers);
        uint32 idx = _insert(l.change);
        emit NoteCommitted(idx, l.change, l.encryptedChange);

        address token = tokenOfResource[l.resource];
        if (token != address(0)) {
            shieldedBalance[token] -= l.amount + l.fee;
            TransferHelper.push(IERC20(token), adapter, l.amount);
            if (l.fee != 0) {
                if (feeRecipient == address(0)) revert BadFeeTerms();
                TransferHelper.push(IERC20(token), feeRecipient, l.fee);
            }
            input = IShieldedAdapter.Input(token, 0, l.amount);
        } else {
            ShareInfo memory s = shareOf[l.resource];
            if (s.adapter != adapter) revert NotAdapterShare(l.resource);
            if (l.fee != 0) revert BadFeeTerms();
            input = IShieldedAdapter.Input(address(0), s.shareId, l.amount);
        }
        emit LegSpent(adapter, token, l.resource, l.amount, l.fee);
    }

    /// @dev `fungibleIn`: the action spent token notes (a swap or an entry). Such an action may
    ///      not create notes of an asset whose shielding is switched off; exits always may.
    function _settleOutput(ExecuteArgs calldata a, uint256 j, IShieldedAdapter.Output memory o, bool fungibleIn)
        private
    {
        OutputSpec calldata s = a.outputs[j];
        if (o.amount > MAX_AMOUNT) revert BadAmount();
        if (o.amount < s.fee) revert FeeExceedsOutput(j);
        uint256 net = o.amount - s.fee;
        uint256 protocolFee;
        uint256 leaf = type(uint256).max;
        if (o.token != address(0)) {
            uint256 resource = _assets[o.token].resource;
            if (resource == 0) revert UnknownAsset(o.token);
            if (s.fee != 0) {
                if (a.feeRecipient == address(0)) revert BadFeeTerms();
                TransferHelper.push(IERC20(o.token), a.feeRecipient, s.fee);
            }
            if (s.recipient != address(0)) {
                if (s.encryptedNote.length != 0) revert BadOutput(j);
                protocolFee = (net * withdrawFeeBps + 9999) / 10000;
                protocolFeesAccrued[o.token] += protocolFee;
                if (net > protocolFee) TransferHelper.push(IERC20(o.token), s.recipient, net - protocolFee);
            } else if (net != 0) {
                if (fungibleIn && !_assets[o.token].shieldingEnabled) revert AssetNotShieldable(o.token);
                shieldedBalance[o.token] += net;
                leaf = _insertOpen(resource, net, s);
            }
        } else {
            if (s.fee != 0 || s.recipient != address(0)) revert BadOutput(j);
            uint256 resource = shareResource(a.adapter, o.shareId);
            ShareInfo storage info = shareOf[resource];
            if (info.adapter == address(0)) {
                info.adapter = a.adapter;
                info.shareId = o.shareId;
                emit ShareRegistered(resource, a.adapter, o.shareId);
            }
            if (net != 0) leaf = _insertOpen(resource, net, s);
        }
        emit OutputSettled(a.adapter, j, o.token, o.shareId, o.amount, s.fee, s.recipient, protocolFee, leaf);
    }

    /// @dev A note whose amount is only known on-chain. The owner's ciphertext (version 2)
    ///      carries the resource and blinding; the contract appends the amount.
    function _insertOpen(uint256 resource, uint256 amount, OutputSpec calldata s) private returns (uint256 leaf) {
        if (s.ownerHash >= FIELD_SIZE) revert NotAFieldElement();
        _checkCiphertext(s.encryptedNote, OPEN_AMOUNT_NOTE_VERSION);
        uint256 commitment = PoseidonT5.hash([resource, amount, s.ownerHash, noteDomain]);
        leaf = _insert(commitment);
        emit NoteCommitted(leaf, commitment, abi.encodePacked(s.encryptedNote, uint128(amount)));
    }

    function _checkBacking(address token) private view {
        if (IERC20(token).balanceOf(address(this)) < shieldedBalance[token] + protocolFeesAccrued[token]) {
            revert Undercollateralised(token);
        }
    }

    function _spend(uint256[2] calldata nullifiers) private {
        if (nullifiers[0] == nullifiers[1]) revert DuplicateNullifier();
        for (uint256 i = 0; i < 2; i++) {
            uint256 n = nullifiers[i];
            if (n >= FIELD_SIZE) revert NotAFieldElement();
            if (nullifierSpent[n]) revert NullifierAlreadySpent(n);
            nullifierSpent[n] = true;
            emit NullifierSpent(n);
        }
    }

    function _insert(uint256 leaf) private returns (uint32 index) {
        index = nextLeafIndex;
        if (uint256(index) >= (uint256(1) << LEVELS)) revert TreeFull();
        uint256 node = leaf;
        uint256 i = index;
        for (uint256 level = 0; level < LEVELS; level++) {
            if (i & 1 == 0) {
                _filledSubtrees[level] = node;
                node = PoseidonT3.hash([node, zeros(level)]);
            } else {
                node = PoseidonT3.hash([_filledSubtrees[level], node]);
            }
            i >>= 1;
        }
        uint32 next = (currentRootIndex + 1) % ROOT_HISTORY;
        currentRootIndex = next;
        _roots[next] = node;
        nextLeafIndex = index + 1;
    }
}
