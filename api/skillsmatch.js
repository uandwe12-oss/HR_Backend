const express = require("express");
const router = express.Router();
const getDriver = require("../lib/neo4j");
const neo4j = require('neo4j-driver');

// Helper function to convert Neo4j integer to number
const toNumber = (value) => {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }
  return value || 0;
};

// Helper function to safely extract and split skills from various formats
const extractSkills = (skillsField) => {
  if (!skillsField) return [];
  
  console.log("Extracting skills from:", skillsField);
  console.log("Type:", typeof skillsField);
  
  // If it's already an array
  if (Array.isArray(skillsField)) {
    const cleaned = skillsField.filter(s => s && typeof s === 'string' && s.trim()).map(s => s.trim());
    console.log("Array input, cleaned:", cleaned);
    return cleaned;
  }
  
  // If it's a string
  if (typeof skillsField === 'string') {
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(skillsField);
      console.log("Parsed JSON:", parsed);
      if (Array.isArray(parsed)) {
        const cleaned = parsed.filter(s => s && typeof s === 'string' && s.trim()).map(s => s.trim());
        console.log("JSON array, cleaned:", cleaned);
        return cleaned;
      }
      if (typeof parsed === 'string') {
        console.log("JSON string:", [parsed.trim()]);
        return [parsed.trim()];
      }
    } catch (e) {
      console.log("Not JSON, treating as regular string");
    }
    
    // Check if it contains commas
    if (skillsField.includes(',')) {
      const cleaned = skillsField.split(',').map(s => s.trim()).filter(s => s);
      console.log("Split by comma:", cleaned);
      return cleaned;
    }
    
    // Single skill
    const trimmed = skillsField.trim();
    console.log("Single skill:", trimmed ? [trimmed] : []);
    return trimmed ? [trimmed] : [];
  }
  
  // If it's an object with properties
  if (typeof skillsField === 'object' && skillsField !== null) {
    if (skillsField.low !== undefined) {
      // Neo4j list
      const values = [];
      for (let i = 0; i < skillsField.length; i++) {
        const val = skillsField[i];
        if (val && val.toString) {
          values.push(val.toString().trim());
        }
      }
      console.log("Neo4j list:", values);
      return values;
    }
  }
  
  console.log("No skills found, returning empty array");
  return [];
};

/**
 * GET – Match Candidates by Skill
 */
router.get("/", async (req, res) => {
  const { skill } = req.query;

  console.log(`\n📡 GET /api/skillsmatch - Filtering by skill: "${skill}"`);

  if (!skill) {
    return res.status(400).json({
      success: false,
      message: "Skill query parameter is required"
    });
  }

  const driver = getDriver();
  const session = driver.session();

  try {
    // Get all candidates
    const result = await session.run(
      "MATCH (c:Candidate_Profile) RETURN c"
    );

    console.log(`Found ${result.records.length} total candidates`);

    // Filter candidates that have the matching skill
    const candidates = [];
    result.records.forEach(record => {
      const candidate = record.get("c").properties;
      const candidateName = candidate["Candidate Name"] || candidate.name;
      const skillsField = candidate["Key Skills"];
      
      // Extract skills properly
      const skills = extractSkills(skillsField);
      
      console.log(`Candidate: ${candidateName}`);
      console.log(`  Raw skills field:`, skillsField);
      console.log(`  Parsed skills:`, skills);
      
      // Check if any skill matches (case-insensitive)
      const hasSkill = skills.some(s => s.toLowerCase() === skill.toLowerCase());
      
      if (hasSkill) {
        console.log(`  ✅ MATCH: ${candidateName} has skill: ${skill}`);
        candidates.push(candidate);
      } else {
        console.log(`  ❌ No match for skill: ${skill}`);
      }
    });

    console.log(`✅ Found ${candidates.length} candidates with skill: ${skill}`);

    res.json({
      success: true,
      selectedSkill: skill,
      count: candidates.length,
      data: candidates
    });

  } catch (err) {
    console.error("Error matching candidates:", err);
    res.status(500).json({
      success: false,
      message: "Failed to match candidates",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

/**
 * GET – Fetch All Skills with Counts (For Dropdown)
 */
router.get("/skills", async (req, res) => {
  const driver = getDriver();
  const session = driver.session();

  try {
    // Get all skills from Skill nodes
    const skillsResult = await session.run(
      "MATCH (s:Skill) RETURN s.name AS skillName ORDER BY s.name ASC"
    );
    
    const masterSkills = skillsResult.records.map(record => record.get("skillName"));
    console.log(`Found ${masterSkills.length} master skills`);
    
    // Get all candidates to count skills
    const candidatesResult = await session.run(
      "MATCH (c:Candidate_Profile) WHERE c.`Key Skills` IS NOT NULL RETURN c.`Key Skills` AS skillsField"
    );
    
    // Count skills from candidates
    const skillCountMap = new Map();
    
    candidatesResult.records.forEach(record => {
      const skillsField = record.get("skillsField");
      const skills = extractSkills(skillsField);
      
      // Use Set to avoid counting same skill multiple times per candidate
      const uniqueSkills = [...new Set(skills)];
      uniqueSkills.forEach(skill => {
        if (skill) {
          const count = skillCountMap.get(skill) || 0;
          skillCountMap.set(skill, count + 1);
        }
      });
    });
    
    // Combine master skills with counts
    const skills = masterSkills.map(skillName => ({
      name: skillName,
      count: skillCountMap.get(skillName) || 0
    }));
    
    // Sort by count descending
    skills.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
    
    // Get total candidates count
    const totalCandidatesResult = await session.run(
      "MATCH (c:Candidate_Profile) RETURN COUNT(c) AS total"
    );
    const totalCandidates = toNumber(totalCandidatesResult.records[0].get("total"));

    res.json({
      success: true,
      totalSkills: skills.length,
      totalCandidates: totalCandidates,
      data: skills
    });

  } catch (err) {
    console.error("Error fetching skills:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch skills",
      error: err.message
    });
  } finally {
    await session.close();
  }
});

module.exports = router;