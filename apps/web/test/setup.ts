import { MotionGlobalConfig } from 'motion/react';

// The tests read what the screens say, not how they move: every animation ends at once (and
// happy-dom's Web Animations reject the promise of one cancelled half-way).
MotionGlobalConfig.skipAnimations = true;
