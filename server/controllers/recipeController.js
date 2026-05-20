const { groq } = require("../config/gemini");
const Recipe = require("../models/Recipe");

// ── POST /api/recipes/analyze ────────────────────────────────
const analyzeImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded" });
    }

    // STEP A: Convert buffer to Base64 with MIME type
    const base64Image = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype;

    // STEP B: Call Groq Vision (LLaMA 4 Scout)
    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
              },
            },
            {
              type: "text",
              text: 'Analyze this food image carefully. Identify all visible ingredients, food items, or dishes. Return ONLY a JSON array of ingredient names. Example: ["tomato", "onion", "chicken", "rice"]. If this is a prepared dish, identify the dish name and its likely ingredients.',
            },
          ],
        },
      ],
      max_tokens: 500,
    });

    const text = response.choices[0].message.content;

    // STEP C: Parse JSON array from the response
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    let ingredients = [];

    if (jsonMatch) {
      try {
        ingredients = JSON.parse(jsonMatch[0]);
      } catch {
        // Fallback: split comma-separated plain text if JSON is malformed
        ingredients = text
          .replace(/[\[\]"]/g, "")
          .split(",")
          .map((i) => i.trim())
          .filter(Boolean);
      }
    }

    res.json({ ingredients, rawResponse: text });
  } catch (error) {
    console.error("Image analysis error:", error);
    res.status(500).json({ error: "Failed to analyze image" });
  }
};

// ── POST /api/recipes/generate ───────────────────────────────
const generateRecipe = async (req, res) => {
  try {
    const { ingredients, dietaryPreference } = req.body;

    if (!ingredients || ingredients.length === 0) {
      return res.status(400).json({
        error: "Ingredients are required",
      });
    }

    const dietFilter = dietaryPreference
      ? `The recipe MUST be ${dietaryPreference}-friendly.`
      : "";

    const prompt = `
You are a professional chef.

Using these ingredients:
${ingredients.join(", ")}

${dietFilter}

Return ONLY valid JSON.

{
  "title": "Recipe Name",
  "ingredients": [
    {
      "name": "ingredient",
      "quantity": "amount"
    }
  ],
  "instructions": [
    {
      "step": 1,
      "description": "instruction"
    }
  ],
  "nutrition": {
    "calories": "value",
    "protein": "value",
    "carbs": "value",
    "fat": "value",
    "fiber": "value"
  },
  "servings": "value",
  "prepTime": "value",
  "cookTime": "value",
  "difficulty": "Easy",
  "dietaryTags": [],
  "servingSuggestions": []
}
`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
      max_tokens: 1500,
    });

    const text = response.choices[0].message.content;

    console.log("RAW GROQ RESPONSE:");
    console.log(text);

    // Remove markdown formatting
    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    // Extract JSON safely
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return res.status(500).json({
        error: "No valid JSON returned from AI",
      });
    }

    let recipe;

    try {
      recipe = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error("JSON Parse Error:", parseError);

      return res.status(500).json({
        error: "Invalid JSON returned from AI",
      });
    }

    recipe.detectedIngredients = ingredients;

    res.json({ recipe });

  } catch (error) {
    console.error("Recipe generation error:", error);

    res.status(500).json({
      error: "Failed to generate recipe",
    });
  }
};
// ── POST /api/recipes/suggestions ───────────────────────────
const generateMultipleRecipes = async (req, res) => {
  try {
    const { ingredients, dietaryPreference } = req.body;

    if (!ingredients || ingredients.length === 0) {
      return res.status(400).json({ error: "Ingredients are required" });
    }

    const dietFilter = dietaryPreference
      ? `All recipes MUST be${dietaryPreference}-friendly.`
      : "";

    const prompt = `You are a professional chef. Based on these ingredients:${ingredients.join(", ")}.
${dietFilter}

Suggest 3 different recipes that can be made. Return ONLY valid JSON array (no markdown):
[
  {
    "title": "Recipe Name",
    "description": "Brief 1-line description",
    "difficulty": "Easy/Medium/Hard",
    "cookTime": "estimated time",
    "dietaryTags": ["applicable tags"]
  }
]`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
    });

    const text = response.choices[0].message.content;

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "Failed to parse suggestions" });
    }

    const suggestions = JSON.parse(jsonMatch[0]);
    res.json({ suggestions });
  } catch (error) {
    console.error("Multiple recipe error:", error);
    res.status(500).json({ error: "Failed to generate suggestions" });
  }
};

// ── POST /api/recipes/save ───────────────────────────────────
const saveRecipe = async (req, res) => {
  try {
    const recipe = new Recipe(req.body);
    const saved = await recipe.save();
    res.status(201).json(saved);
  } catch (error) {
    console.error("Save recipe error:", error);
    res.status(500).json({ error: "Failed to save recipe" });
  }
};

// ── GET /api/recipes/saved ───────────────────────────────────
const getSavedRecipes = async (req, res) => {
  try {
    const { diet, difficulty, search } = req.query;
    const filter = {};

    if (diet)       filter.dietaryTags  = diet;
    if (difficulty) filter.difficulty   = difficulty;
    if (search)     filter.title        = { $regex: search, $options: "i" };

    const recipes = await Recipe.find(filter).sort({ createdAt: -1 });
    res.json(recipes);
  } catch (error) {
    console.error("Get recipes error:", error);
    res.status(500).json({ error: "Failed to fetch recipes" });
  }
};

// ── GET /api/recipes/saved/:id ───────────────────────────────
const getRecipeById = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }
    res.json(recipe);
  } catch (error) {
    console.error("Get recipe error:", error);
    res.status(500).json({ error: "Failed to fetch recipe" });
  }
};

// ── DELETE /api/recipes/saved/:id ────────────────────────────
const deleteRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findByIdAndDelete(req.params.id);
    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }
    res.json({ message: "Recipe deleted successfully" });
  } catch (error) {
    console.error("Delete recipe error:", error);
    res.status(500).json({ error: "Failed to delete recipe" });
  }
};

module.exports = {
  analyzeImage,
  generateRecipe,
  generateMultipleRecipes,
  saveRecipe,
  getSavedRecipes,
  getRecipeById,
  deleteRecipe,
};

