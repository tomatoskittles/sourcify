const chai = require('chai');
const Path = require('path');
const ValidationService = require('../build/ValidationService').ValidationService;
const validationService = new ValidationService();

function objectLength(obj) {
    return Object.keys(obj).length;
}

describe("ValidationService", function() {
    describe("#checkPaths", function() {
        it("should succeed for single source file", async function() {
            const ignoring = [];
            const paths = [Path.join("test", "files", "single")];
            const checkedContracts = await validationService.checkPaths(paths, ignoring);
            
            chai.expect(ignoring).to.be.empty;
            expectationsOfSingle(checkedContracts);
        });

        it("should succeed for single source file, everything provided individually", async function() {
            const ignoring = [];
            const paths = [
                Path.join("test", "files", "single", "1_Storage.sol"),
                Path.join("test", "files", "single", "metadata.json")
            ];
            const checkedContracts = await validationService.checkPaths(paths, ignoring);
            
            chai.expect(ignoring).to.be.empty;
            expectationsOfSingle(checkedContracts);
        })

        function expectationsOfSingle(checkedContracts) {
            chai.expect(checkedContracts.length).to.equal(1);
            const onlyContract = checkedContracts[0];
            
            chai.expect(onlyContract.name).to.equal("Storage");
            chai.expect(onlyContract.compiledPath).to.equal("browser/1_Storage.sol");
            
            chai.expect(onlyContract.isValid());
            chai.expect(objectLength(onlyContract.solidity)).to.equal(1);
            chai.expect(onlyContract.solidity).to.have.all.keys("browser/1_Storage.sol");
            chai.expect(onlyContract.missing).to.be.empty;
            chai.expect(onlyContract.invalid).to.be.empty;
        }

        it("should report for single source file missing", async function() {
            const ignoring = [];
            const paths = [Path.join("test", "files", "single", "metadata.json")];
            const checkedContracts = await validationService.checkPaths(paths, ignoring);

            chai.expect(ignoring).to.be.empty;
            chai.expect(checkedContracts.length).to.equal(1);
            const onlyContract = checkedContracts[0];

            chai.expect(onlyContract.name).to.equal("Storage");
            chai.expect(onlyContract.compiledPath).to.equal("browser/1_Storage.sol");

            chai.expect(!onlyContract.isValid());
            chai.expect(onlyContract.solidity).to.be.empty;
            chai.expect(objectLength(onlyContract.missing)).to.equal(1);
            chai.expect(onlyContract.missing).to.have.key("browser/1_Storage.sol");
            chai.expect(onlyContract.invalid).to.be.empty;
        });

        it("should throw for no metadata found", async function() {
            const paths = [Path.join("test", "files", "single", "1_Storage.sol")];
            try {
                await validationService.checkPaths(paths);
                chai.assert.fail();
            } catch (err) {
                chai.expect(err.name).to.equal("Error"); // assert the error is not an AssertionError
            }
        });

        it("should ignore invalid paths", async function() {
            const ignoring = [];
            const invalidPath = Path.join("test", "files", "foobar.sol");
            const paths = [
                Path.join("test", "files", "single"),
                invalidPath
            ];
            const checkedContracts = await validationService.checkPaths(paths, ignoring);

            chai.expect(ignoring).to.deep.equal([invalidPath]);
            expectationsOfSingle(checkedContracts);
        });
    });
});