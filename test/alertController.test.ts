/**
 * Unit tests for AlertController.
 *
 * These tests verify the alert latching logic in isolation.
 * No VS Code instance is required — jest.fn() replaces the
 * real vscode.window.showWarningMessage callback.
 *
 * Run with: npm test
 */

import { AlertController } from '../src/business/alertController';
import { ModeManager } from '../src/business/modeManager';

describe('AlertController', () => {

  it('fires alert when BRI hits severe in Standard mode', () => {
    // Arrange
    const mockAlert = jest.fn();
    const mode = new ModeManager('Standard');
    const controller = new AlertController(mode, mockAlert);

    // Act
    controller.check('severe');

    // Assert
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert).toHaveBeenCalledWith('severe');
  });

  it('does not fire alert at moderate in Standard mode', () => {
    // Arrange
    const mockAlert = jest.fn();
    const mode = new ModeManager('Standard');
    const controller = new AlertController(mode, mockAlert);

    // Act
    controller.check('moderate');

    // Assert
    expect(mockAlert).toHaveBeenCalledTimes(0);
  });

  it('fires alert at moderate in Strict mode', () => {
    // Arrange
    const mockAlert = jest.fn();
    const mode = new ModeManager('Strict');
    const controller = new AlertController(mode, mockAlert);

    // Act
    controller.check('moderate');

    // Assert
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert).toHaveBeenCalledWith('moderate');
  });

  it('does not fire alert twice at the same severity level', () => {
    // Arrange
    const mockAlert = jest.fn();
    const mode = new ModeManager('Standard');
    const controller = new AlertController(mode, mockAlert);

    // Act — check severe three times in a row
    controller.check('severe');
    controller.check('severe');
    controller.check('severe');

    // Assert — alert fires only once due to latching
    expect(mockAlert).toHaveBeenCalledTimes(1);
  });

  it('resets latch when BRI drops to low allowing future alerts', () => {
    // Arrange
    const mockAlert = jest.fn();
    const mode = new ModeManager('Standard');
    const controller = new AlertController(mode, mockAlert);

    // Act — escalate, drop, escalate again
    controller.check('severe'); // fires — count: 1
    controller.check('low');    // resets latch
    controller.check('severe'); // fires again — count: 2

    // Assert
    expect(mockAlert).toHaveBeenCalledTimes(2);
  });

});
