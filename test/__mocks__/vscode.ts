// Mock of the VS Code API for unit testing outside the extension host.
// Only the parts actually used by the tested modules are mocked.

export const window = {
  showWarningMessage: jest.fn(),
  showInformationMessage: jest.fn()
};

export const workspace = {
  textDocuments: []
};
