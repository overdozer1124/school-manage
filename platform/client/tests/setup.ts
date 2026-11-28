import { configure } from "@testing-library/react";

// The login tests are integration-style: they render the whole
// app against a fake API, and one user action can mean several
// awaited rounds before the next screen stands. Testing Library's
// default async wait (1s) is sized for unit tests; five seconds
// still fails a genuinely stuck test well inside the 20s test
// timeout (the schedule screens' setup makes the same choice).
configure({ asyncUtilTimeout: 5000 });
