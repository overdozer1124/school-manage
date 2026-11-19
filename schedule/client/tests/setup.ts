import { configure } from "@testing-library/react";

// The client tests are integration-style: they render the whole
// app against an in-memory adapter, and one user action can mean
// a write, a range re-read and a full table re-render before the
// awaited state stands. Testing Library's default async wait
// (1s) is sized for unit tests; under a full parallel suite run
// on a loaded machine a single such round trip legitimately
// takes longer, and the wait — never the assertion — gave up
// first (Issue #100). Five seconds still fails a genuinely stuck
// test well inside the 20s test timeout.
configure({ asyncUtilTimeout: 5000 });
