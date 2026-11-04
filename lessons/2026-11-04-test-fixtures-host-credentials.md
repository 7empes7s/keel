# Test fixtures must not read the host's tenant credentials

The full suite on an operator-equipped machine found discovery fixtures reading
its workload scope, and PowerShell fixtures resolving installed Exchange and Purview credential
filenames. Discovery rejected the fixture tenant; credential staging changed the
DSC job's connection path and broke assertions that passed on a clean CI host.

Use credential filenames reserved for fixtures, inject default-file presence, and
stub PowerShell command listing when it is outside the test's purpose. Test
results must not depend on whether operator credentials exist on the machine.
