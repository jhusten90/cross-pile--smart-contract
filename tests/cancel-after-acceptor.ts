import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { MockOracleSession, SOLRAND_IDL, PROGRAM_ID } from '@demox-labs/solrand';
import { SolrandSession } from '../app/solrandSession';
import { CrossPile } from '../target/types/cross_pile';
import { Session, User } from "../app/sessions";
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { expect } from 'chai';
import { TimeLogger, CommitmentLevel, instantiateSessions, createMintsInParallel, createChallengesWithAddressAndBump, newChallenges } from '../app/utils';
import { Challenge } from '../app/challenge';

const timeLogger = new TimeLogger();
timeLogger.disable();
const program = anchor.workspace.CrossPile as Program<CrossPile>;
const ENV = 'http://localhost:8899';
const uuid = Math.floor(Math.random() * 2**50);

describe('cancel_after_acceptor', () => {
    timeLogger.log("beginning cancel after acceptor tests");

    after(() => {
        timeLogger.log("all cancel after acceptor tests finished");
        timeLogger.outputAllLogs();
    });

    const solrandId = new anchor.web3.PublicKey(PROGRAM_ID);
    const oracleKeypair = anchor.web3.Keypair.generate();
    const oracleSession = new MockOracleSession(oracleKeypair, SOLRAND_IDL, solrandId, ENV);

    let initiatorSessions = instantiateSessions(1, program, ENV, timeLogger);
    let acceptorSessions = instantiateSessions(1, program, ENV, timeLogger);
    let solrandSessions = initiatorSessions.map((session) => new SolrandSession(session.userKeypair, SOLRAND_IDL, solrandId, oracleKeypair.publicKey, ENV, uuid));

    let allUserSessions = initiatorSessions.concat(acceptorSessions);

    const thirdPartySession = new Session(program, ENV, timeLogger);

    const mintAuthority = thirdPartySession.userKeypair;
    let mint1: PublicKey;
    let mint2: PublicKey;

    let expectedChallenges: Challenge[];
    let initiators: User[];
    let acceptors: User[];

    const initialTokenFundAmount = 2000;
    it('Set up tests', async() => {
        await Promise.all([
            thirdPartySession.requestAirdrop(),
            allUserSessions.map((session) => session.requestAirdrop()),
            oracleSession.provider.connection.confirmTransaction(
                await oracleSession.provider.connection.requestAirdrop(oracleKeypair.publicKey, 10000000000),
            ),
            solrandSessions.map((session) => session.setAccounts())
        ]);

        timeLogger.log("creating mints and initializing solrand accounts");

        let mintPromises = createMintsInParallel(2, thirdPartySession);
        await Promise.all([
            ...mintPromises,
            solrandSessions.map((session) => session.initializeAccount())
        ]).then((values) => {
            mint1 = values[0] as PublicKey;
            mint2 = values[1] as PublicKey;
        });
        timeLogger.log("mints created, solrand initialized");

        await Promise.all(
            initiatorSessions.map((session) => session.fundTokens(initialTokenFundAmount, mint1, mintAuthority)).concat(
            acceptorSessions.map((session) => session.fundTokens(initialTokenFundAmount, mint2, mintAuthority)))
        );

        initiators = initiatorSessions.map((initiatorSession) => new User(initiatorSession));
        acceptors = acceptorSessions.map((acceptorSession) => new User(acceptorSession));

        expectedChallenges = await createChallengesWithAddressAndBump(program.programId, initiators, solrandSessions);
        const initiatorWagerTokenAmount = 1000;

        await Promise.all(
            newChallenges(initiators, solrandSessions, initiatorWagerTokenAmount, expectedChallenges)
        );
    });

    describe('cancel-after-acceptor', () => {
        it('cancels the challenge after an acceptor', async () => {
            let testIndex = 0;
            let initiator = initiators[testIndex];
            let acceptor = acceptors[testIndex];
            let expectedChallenge = expectedChallenges[testIndex];

            const acceptorWagerTokenAmount = 37;
            const acceptorWagerTokenAmountBigNumber = new anchor.BN(acceptorWagerTokenAmount);

            timeLogger.log("accepting challenge");
            await acceptor.acceptChallenge(
                expectedChallenge.address,
                acceptorWagerTokenAmountBigNumber
                );

            timeLogger.log("challenge accepted");
            timeLogger.log("the owner of the tokens source is: " + acceptor.session.tokensSource.owner.toString());
            timeLogger.log("the acceptor is: " + acceptor.session.userKeypair.publicKey.toString());

            let cancelTx = await initiator.cancelAfterAcceptor(
                expectedChallenge.address,
                acceptor.session.userKeypair.publicKey,
                acceptor.tokensVaultAddress,
                acceptor.session.tokensSource.address
                );
            await initiator.session.provider.connection.confirmTransaction(
                cancelTx,
                CommitmentLevel.FINALIZED
            );

            let initiatorTokensSource;
            let acceptorTokensSource;
            let programAccounts;
            await Promise.all([
                initiator.session.getOrCreateAssociatedTokenAccount(mint1, mintAuthority),
                acceptor.session.getOrCreateAssociatedTokenAccount(mint2, mintAuthority),
                initiator.session.solConnection.getProgramAccounts(program.programId)
            ]).then((values) => {
                initiatorTokensSource = values[0];
                acceptorTokensSource = values[1];
                programAccounts = values[2];
            });
            let accountPubkeyStrings = programAccounts.map((account) => account.pubkey.toString());
            
            expect(Number(acceptorTokensSource.amount), "Acceptor token source should be full amount.")
                .equals(initialTokenFundAmount);
            expect(Number(initiatorTokensSource.amount), "Initiator token source should be full amount.")
                .equals(initialTokenFundAmount);
            expect(accountPubkeyStrings, "Challenge should be deleted.").not.include(expectedChallenge.address);
        });
    });
});