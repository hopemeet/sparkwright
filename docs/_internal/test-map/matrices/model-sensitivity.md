# Model Sensitivity Matrix

SparkWright tests should say what kind of model behavior they depend on. A
green deterministic test does not prove the same prompt will drive a real model
through the same route, and a real-model route change is not automatically a
product bug.

## Model Classes

| Class               | Use For                                               | Do Not Use For                                            |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `deterministic`     | stable CLI/host/core invariants, no provider variance | testing judgment, planning quality, prompt robustness     |
| `scripted`          | exact tool-call order, edge events, regression traces | measuring model choice or natural behavior                |
| `fake adapter`      | package-local unit behavior and error injection       | end-to-end prompt/tool interaction                        |
| real provider/model | canary runs and behavior observations                 | release gates unless scenario is robust to route variance |

## Stable Assertions By Model Class

Deterministic/scripted tests can assert:

- exact event families
- exact tool names when scripted
- exit code
- structured payload fields
- schema shape
- report severity/code

Real-model tests should prefer:

- safety boundaries held
- writes are trace-visible
- verification failure exits non-zero
- raw trace contains expected evidence class
- no false success when required action failed

Avoid in real-model tests:

- exact assistant prose
- exact step count
- exact tool order unless the prompt explicitly requires it and the harness
  validates the model complied
- exact verification command unless the scenario makes it the task

## Failure Classification

When a model-dependent test fails, classify first:

- `product_bug`: invariant violated regardless of route.
- `prompt_underspecified`: prompt did not force the route being asserted.
- `model_variance`: model chose a different valid route.
- `test_bug`: test asserted a non-invariant.

Only `product_bug` should normally drive code changes. The other causes should
update scenarios, prompts, or assertions.
