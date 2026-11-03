# Dedicated lesson response

This is the response format for dedicated Pi, Claude Code, and Codex teachers.
The private key and plan examples elsewhere describe files that the service writes;
do not copy those file shapes into this response. This complete example shows the
three separate obligations: the original prequestion rubric, the original check
rubric, and the private variants of that check. The variants never stand in for
an original question. Choose content and controls for the requested objective;
the example topic, names, question counts, and layout are not requirements.

Build the original `quizzes` inventory before the private `variants` pool. For each
`form.cl-quiz` in `lesson_html`, including forms inside a template, provide one
quiz row. For each original `li.cl-q`, provide its own question row, rubric, and
mapping. Then add two or three variants per check question. Cross-check exact ids
against the original inventory. Keep private expected answers, criteria, mappings,
and variant HTML out of `lesson_html`.

The response control and the cognitive task are separate contracts. HTML
`data-type` chooses a control: `choice`, `multi`, `term`, `short`, `numeric`,
`cloze`, `order`, `match`, `locate`, or `code`. The private `task` chooses what
thinking the question requires. For a written prediction, use `data-type="short"`
with a textarea and `task: "prediction"` in the private question row. Never put
`prediction`, `explanation`, `application`, or another mental-task label in
`data-type`. Check this separately for every original and variant fragment.

Gates require balanced HTML. Close all containers opened inside a template before
`</template>`; close containers outside it outside it. Indent the teaching and
check as siblings where appropriate. Do not rely on the browser to repair tags.
The host validates both hidden source and released content, then checks the page.

`syllabus_skills` lists the ids of the `syllabusCoverage` topics the lesson teaches,
or `[]` when none apply. Use `null` only when the classroom resources have no
`syllabusCoverage`. Unknown ids are rejected before anything is saved; on
publication the host adds the lesson to those topics in `syllabus.json`.

```json
{
  "title": "Comparing drying conditions",
  "summary": "Predict how air conditions affect evaporation.",
  "lesson_html": "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Comparing drying conditions</title></head><body><main class=\"cl-lesson-shell\" data-cl-content data-cl-ui=\"2\"><header><h1>Comparing drying conditions</h1><p>Predict which conditions speed evaporation.</p></header><form class=\"cl-quiz cl-card-box\" data-quiz-id=\"before\" data-kind=\"pretest\"><ol class=\"cl-questions\"><li class=\"cl-q\" data-question-id=\"predict\" data-type=\"short\"><p class=\"cl-q-prompt\">Two identical damp towels hang at the same temperature. One is in still air and one in moving air. Predict which dries sooner and explain why.</p><textarea class=\"cl-input\"></textarea></li></ol></form><template data-cl-after-pretest=\"before\"><section id=\"teaching-drying\"><h2>Air near a wet surface</h2><p>Water evaporates from a wet surface. Moving air replaces humid air near that surface with drier air, allowing faster net evaporation when other conditions stay the same. A fan can therefore speed drying without heating the water.</p></section><form class=\"cl-quiz cl-card-box\" data-quiz-id=\"after\" data-kind=\"check\"><ol class=\"cl-questions\"><li class=\"cl-q\" data-question-id=\"compare\" data-type=\"short\"><p class=\"cl-q-prompt\">Two equal wet cloths are equally warm and receive the same airflow. Air around A is nearly saturated with water; air around B is much drier. Which loses water faster, and why?</p><textarea class=\"cl-input\"></textarea></li></ol></form></template><footer><p>Highlight a sentence to ask your teacher.</p><a href=\"./\">Back to classroom</a></footer></main></body></html>",
  "message": "The lesson is ready.",
  "objectives": [
    {
      "id": "drying",
      "statement": "Predict relative evaporation rates from local air conditions.",
      "application": true,
      "retentionDays": null,
      "interleaveGroup": null,
      "strategy": null
    }
  ],
  "quizzes": [
    {
      "id": "before",
      "purpose": "prequestion",
      "questions": [
        {
          "id": "predict",
          "rubric": {
            "criteria": [
              {
                "id": "prediction",
                "description": "Select the faster drying case.",
                "points": 1
              },
              {
                "id": "reason",
                "description": "Explain the humidity difference near the surface.",
                "points": 1
              }
            ],
            "expected": "The towel in moving air dries sooner because moving air replaces humid air at its surface.",
            "points": 2,
            "full": "Correct comparison with a causal explanation; accept equivalent wording.",
            "partial": "One point for the correct comparison and one for the humidity explanation. Award either independently.",
            "grading": null
          },
          "objective": "drying",
          "task": "prediction",
          "support": "independent",
          "teaching": "teaching-drying"
        }
      ]
    },
    {
      "id": "after",
      "purpose": "assessment",
      "questions": [
        {
          "id": "compare",
          "rubric": {
            "criteria": [
              {
                "id": "prediction",
                "description": "Select the faster drying case.",
                "points": 1
              },
              {
                "id": "reason",
                "description": "Explain the humidity difference near the surface.",
                "points": 1
              }
            ],
            "expected": "B loses water faster because the drier surrounding air permits greater net evaporation.",
            "points": 2,
            "full": "Correct comparison with a causal explanation; accept equivalent wording.",
            "partial": "One point for the correct comparison and one for the humidity explanation. Award either independently.",
            "grading": null
          },
          "objective": "drying",
          "task": "application",
          "support": "independent",
          "teaching": null
        }
      ]
    }
  ],
  "variants": [
    {
      "quiz": "after",
      "question": "compare",
      "id": "v1",
      "html": "<li class=\"cl-q\" data-question-id=\"v1\" data-type=\"short\"><p class=\"cl-q-prompt\">Two identical wet pads sit at the same temperature. A fan blows dry air past X; Y is in still air. Predict the faster drying pad and explain.</p><textarea class=\"cl-input\"></textarea></li>",
      "rubric": {
        "criteria": [
          {
            "id": "prediction",
            "description": "Select the faster drying case.",
            "points": 1
          },
          {
            "id": "reason",
            "description": "Explain the humidity difference near the surface.",
            "points": 1
          }
        ],
        "expected": "X dries faster because moving air carries away humid air near its surface.",
        "points": 2,
        "full": "Correct comparison with a causal explanation; accept equivalent wording.",
        "partial": "One point for the correct comparison and one for the humidity explanation. Award either independently.",
        "grading": null
      },
      "task": "application"
    },
    {
      "quiz": "after",
      "question": "compare",
      "id": "v2",
      "html": "<li class=\"cl-q\" data-question-id=\"v2\" data-type=\"short\"><p class=\"cl-q-prompt\">Two wet sheets receive equal airflow at equal temperature. One is in a humid room, the other in a dry room. Predict the faster drying sheet and explain.</p><textarea class=\"cl-input\"></textarea></li>",
      "rubric": {
        "criteria": [
          {
            "id": "prediction",
            "description": "Select the faster drying case.",
            "points": 1
          },
          {
            "id": "reason",
            "description": "Explain the humidity difference near the surface.",
            "points": 1
          }
        ],
        "expected": "The sheet in the dry room dries faster because its surrounding air contains less water vapor.",
        "points": 2,
        "full": "Correct comparison with a causal explanation; accept equivalent wording.",
        "partial": "One point for the correct comparison and one for the humidity explanation. Award either independently.",
        "grading": null
      },
      "task": "application"
    }
  ],
  "syllabus_skills": null
}
```
