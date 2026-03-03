import { createLogger } from '@/services/logger';
import {
  buildRippleEditPlan,
  buildRollEditPlan,
  buildSlipEditPlan,
  buildSlideEditPlan,
  toBackendCompoundSteps,
} from '@/agents/tools/compoundEditPlanning';
import { registerCompoundExpander } from './BackendToolExecutor';

const logger = createLogger('RegisterDefaultCompoundExpanders');

let defaultsRegistered = false;

export function registerDefaultCompoundExpanders(): void {
  if (defaultsRegistered) {
    return;
  }

  registerCompoundExpander('ripple_edit', (args) => {
    return toBackendCompoundSteps(buildRippleEditPlan(args).steps);
  });

  registerCompoundExpander('roll_edit', (args) => {
    return toBackendCompoundSteps(buildRollEditPlan(args).steps);
  });

  registerCompoundExpander('slip_edit', (args) => {
    return toBackendCompoundSteps(buildSlipEditPlan(args).steps);
  });

  registerCompoundExpander('slide_edit', (args) => {
    return toBackendCompoundSteps(buildSlideEditPlan(args).steps);
  });

  defaultsRegistered = true;
  logger.info('Registered default backend compound expanders', {
    tools: ['ripple_edit', 'roll_edit', 'slip_edit', 'slide_edit'],
  });
}
