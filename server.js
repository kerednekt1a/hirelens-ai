const { Resend } = require('resend'); 
const resend = new Resend(process.env.RESEND_API_KEY);

require('node:dns').setDefaultResultOrder('ipv4first'); // The "One-Liner" Fix
require('dotenv').config();

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // Temporary RAM storage
const PORT = process.env.PORT || 3000;

// --- 1. CONFIGURATIONS (Now pulling from .env) ---
const dbUri = process.env.dbUri;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AWS_ACCESS_KEY = process.env.MY_AWS_ACCESS_KEY;
const AWS_SECRET_KEY = process.env.MY_AWS_SECRET_KEY;

const client = new MongoClient(dbUri);
const db = client.db("hirelens"); // Force it to use the hirelens DB

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, { apiVersion: 'v1' });

const s3 = new S3Client({
    region: "us-west-2", // Double check your region!
    credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_KEY }
});

app.set('view engine', 'ejs');
app.use(express.static('public')); // For future CSS files
app.use(express.json()); // 👈 This allows the server to understand JSON data!
// Add this right under app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const session = require('express-session');

app.use(session({
    secret: process.env.SESSION_SECRET || 'rebel-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Keep this false until you are 100% sure your live site is HTTPS
}));

// 🛡️ THE MIDDLEWARE: This checks if the user is logged in
function checkAuth(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next(); // 🟢 You're allowed in!
    }
    console.log("🚫 Auth Failed: Redirecting back to login.");
    res.redirect('/login'); // 🔴 This is what's causing the "Blink"
};

// --- 2. ROUTES ---

// A. HOME PAGE: View all jobs
app.get('/', async (req, res) => {
    try {
        await client.connect();
        const jobs = await client.db("hirelens").collection("jobs").find().toArray();
        res.render('index', { jobs });
    } catch (err) {
        res.status(500).send("Database Error: " + err.message);
    }
});

// B. APPLY PAGE: Show the upload form for a specific job
app.get('/apply/:jobId', async (req, res) => {
    try {
        await client.connect();
        const job = await client.db("hirelens").collection("jobs").findOne({ _id: new ObjectId(req.params.jobId) });
        res.render('apply', { job });
    } catch (err) {
        res.status(404).send("Job not found.");
    }
});

// C. THE "MAGIC" POST ROUTE: Handle the file, AI, and Database
app.post('/upload/:jobId', upload.single('resume'), async (req, res) => {
    // 1. Use 'jobId' consistently from the URL parameter
    const jobId = req.params.jobId; 
    const file = req.file;
    // 📝 Match these names exactly to your form input 'name' tags!
    const { candidateName, candidateEmail } = req.body; 

    if (!file) return res.status(400).send("No file uploaded.");

    try {
        console.log(`📑 Processing application for: ${candidateName}`);

        // 2. Upload to S3 (Keep your existing logic here)
        const s3Key = `resumes/${Date.now()}-${file.originalname}`;
        const bucketName = "hirelens-resumes-storage-012838204573-us-west-2-an";
        const s3Url = `https://${bucketName}.s3.amazonaws.com/${s3Key}`;
		
		// 2. Upload to AWS S3
		await s3.send(new PutObjectCommand({
		Bucket: bucketName,
		Key: s3Key,
		Body: file.buffer,
		ContentType: "application/pdf",        // 👈 This tells the browser: "I am a PDF"
		ContentDisposition: "inline"           // 👈 This tells the browser: "Show me, don't save me"
}));
		console.log("☁️ Uploaded to S3 with Display Headers!");

        // 3. AI Analysis
        const base64Data = file.buffer.toString('base64');
        const prompt = "Analyze this resume PDF. Return ONLY a JSON object with: 'score' (0-100), 'summary' (2 sentences), and 'top_3_skills' (array).";
        
        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Data, mimeType: "application/pdf" } }
        ]);

        const cleanJson = result.response.text().replace(/```json|```/g, "").trim();
        const evaluation = JSON.parse(cleanJson);

        // 4. Save to MongoDB - Use jobId consistently
        const applicationData = {
            jobId: new ObjectId(jobId), // 👈 Use the local jobId variable
            candidateName: candidateName,
            candidateEmail: candidateEmail,
            resumeUrl: s3Url,
            evaluation: evaluation,
            appliedAt: new Date(),
            status: "Applied"
        };
        
        const dbResult = await db.collection("candidates").insertOne(applicationData);
        console.log("✅ Mongo Record Created:", dbResult.insertedId);

        // 5. Fetch Job Details for the Email
        let jobTitle = "Unknown Position";
        try {
            // 👈 CRITICAL: Look up using 'jobId' variable, not req.params.id
            const job = await db.collection("jobs").findOne({ _id: new ObjectId(jobId) });
            if (job) {
                jobTitle = job.title;
                console.log(`🎯 Found Job Title: ${jobTitle}`);
            } else {
                console.log("⚠️ Warning: Job ID not found in database lookup.");
            }
        } catch (idErr) {
            console.log("⚠️ Error fetching job title:", idErr.message);
        }

        // 6. Send Email Alert (Using candidateName)


		await resend.emails.send({		
			from: 'HireLens AI <alerts@21stcenturyjobsearch.com>', // <--- Is the 'from:' here?
			to: process.env.EMAIL_USER,
			subject: `🚀 High Score: ${candidateName}`,
			html: `<h1>New Application</h1><p>${candidateName} scored ${evaluation.score}/100</p>`
});
				console.log("📧 Email sent via Resend API!");
			} catch (error) {
				console.error("📧 API Email failed:", error);
			}
		
        // 7. Success Screen
        res.send(`
			<body style="font-family:sans-serif; background:#f4f7f6; margin:0; padding:50px 0; display:flex; flex-direction:column; align-items:center;">
			<div style="margin-bottom: 20px;">
				<img src="/logo.png" alt="Logo" style="height: 60px; display: block;">
			</div>
        
        <div style="background:white; padding:40px; border-radius:15px; box-shadow:0 4px 15px rgba(0,0,0,0.1); max-width: 500px; width: 90%; text-align: center;">
            <h1 style="color:#2ecc71; margin-top:0;">✅ Application Sent!</h1>
            
                    <p>Nice work, <strong>${candidateName}</strong>.</p>
                    <div style="text-align:left;">
                        <h3>AI Analysis:</h3>
                        <p><strong>Score:</strong> ${evaluation.score}/100</p>
                        <p><strong>Summary:</strong> ${evaluation.summary}</p>
                    </div>
                    <br>
                    <a href="/" style="color:#3498db; text-decoration:none;">← Back to Job Board</a>
                </div>
            </body>
        `);

    } catch (err) {
        console.error("❌ Process Failed:", err);
        res.status(500).send("Something went wrong: " + err.message);
    }
});

// ADMIN DASHBOARD: View all candidates
app.get('/admin', checkAuth, async (req, res) => {
    try {
        const db = client.db("hirelens");
        const searchTerm = req.query.search || '';
        const statusFilter = req.query.statusFilter || ''; // 👈 Grab the new filter!
        
        // 1. Build the "Smart" Query
        let query = {};
        
        // If there's a search term, add the name/skills filter
        if (searchTerm) {
            query.$or = [
                { candidateName: { $regex: searchTerm, $options: 'i' } },
                { "evaluation.top_3_skills": { $regex: searchTerm, $options: 'i' } }
            ];
        }

        // 🎯 NEW: If there's a status filter, add it to the query
        if (statusFilter) {
            query.status = statusFilter;
        }

        const candidates = await db.collection("candidates").find(query).sort({ "evaluation.score": -1 }).toArray();
  
		// 2. Fetch ALL jobs (needed for the AI summaries and titles)
        const allJobs = await db.collection("jobs").find().toArray(); 

		// 3. Count statuses for the dashboard stats
		const counts = { Applied: 0, Interviewing: 0, Rejected: 0, Hired: 0 };
		candidates.forEach(c => {
			const status = c.status || 'Applied';
			if (counts[status] !== undefined) {
				counts[status]++;
				}
});

// Now we pass these 'counts' to the EJS file as you already are

		// 4. Attach Job Titles to candidates for the table
		for (let candidate of candidates) {
		// ✨ ADD THE SAFETY CHECK HERE ✨
			if (candidate.jobId) {
					const job = allJobs.find(j => j._id.toString() === candidate.jobId.toString());
				candidate.jobTitle = job ? job.title : "Unknown Job";
			} else {			
        // If there's no jobId at all, don't crash!
				candidate.jobTitle = "No Job Assigned";
			}
		}
// 5. THE HANDOFF: Make sure to pass 'statusFilter' to EJS
        res.render('admin', { 
            candidates: candidates, 
            searchTerm: searchTerm, 
            statusFilter: statusFilter, // 👈 Send this back to keep dropdown selected
            counts: counts, 
            jobs: allJobs 
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Admin Error: " + err.message);
    }
});

app.post('/admin/update-status/:id', async (req, res) => {
    try {
        const { status } = req.body;
        await client.db("hirelens").collection("candidates").updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: status } }
        );
        res.sendStatus(200);
    } catch (err) {
        res.status(500).send(err.message);
    }
});
app.post('/admin/delete-candidate/:id', async (req, res) => {
    try {
        const candidateId = req.params.id;
        const db = client.db("hirelens");

        // 1. FIND THE CANDIDATE FIRST (to get their S3 URL)
        const candidate = await db.collection("candidates").findOne({ _id: new ObjectId(candidateId) });

        if (candidate && candidate.resumeUrl) {
            // Extract the "Key" (filename) from the URL
            // Example URL: https://my-bucket.s3.amazonaws.com/resumes/123-cv.pdf
            // We need: resumes/123-cv.pdf
            const s3Key = candidate.resumeUrl.split('.com/')[1];

            console.log(`🗑️ Deleting file from AWS: ${s3Key}`);
            
            await s3.send(new DeleteObjectCommand({
                Bucket: "hirelens-resumes-storage-012838204573-us-west-2-an", // 👈 Use your bucket name
                Key: s3Key
            }));
        }

        // 2. DELETE FROM MONGODB
        await db.collection("candidates").deleteOne({ _id: new ObjectId(candidateId) });
        
        console.log("✅ Candidate and Resume deleted successfully.");
        res.sendStatus(200);

    } catch (err) {
        console.error("❌ Delete failed:", err);
        res.status(500).send(err.message);
    }
});
app.get('/admin/export', checkAuth, async (req, res) => {
    try {
        const db = client.db("hirelens");
        
        // 1. Grab both filters from the URL
        const searchTerm = req.query.search || '';
        const statusFilter = req.query.statusFilter || '';
        
        // 2. Build the exact same query used on the Dashboard
        let query = {};
        
        if (searchTerm) {
            query.$or = [
                { candidateName: { $regex: searchTerm, $options: 'i' } },
                { "evaluation.top_3_skills": { $regex: searchTerm, $options: 'i' } }
            ];
        }

        if (statusFilter) {
            query.status = statusFilter;
        }

        const candidates = await db.collection("candidates").find(query).toArray();

        // 3. Generate the CSV
        let csvContent = "Name,Email,AI Score,Skills,Status\n";
        candidates.forEach(c => {
            const skills = c.evaluation.top_3_skills ? c.evaluation.top_3_skills.join(" | ") : "N/A";
            // Wrap fields in quotes to prevent commas in names from breaking the CSV
            csvContent += `"${c.candidateName}","${c.candidateEmail}",${c.evaluation.score},"${skills}","${c.status || 'Applied'}"\n`;
        });

        // 4. Send the file
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=hirelens_export_${statusFilter || 'all'}.csv`);
        res.status(200).send(csvContent);

    } catch (err) {
        console.error("Export Error:", err);
        res.status(500).send("Export failed: " + err.message);
    }
});

// 1. Show the "Create Job" Form
app.get('/admin/jobs/new', checkAuth, (req, res) => {
    res.render('create-job');
});

// 2. Handle the Form Submission
app.post('/admin/jobs/new', checkAuth, async (req, res) => {
    try {
        const { title, description, location, salary } = req.body;
        const db = client.db("hirelens");

        let summary = "No summary available."; 

        try {
            // Using your working Gemini 2.5 config
            const model = genAI.getGenerativeModel(
                { model: "gemini-2.5-flash" },
                { apiVersion: 'v1' }
            );

            const prompt = `Summarize this job description in one short sentence for a recruiter: ${description}`;
            const result = await model.generateContent(prompt);
            summary = result.response.text();
            console.log("✨ AI Summary Generated:", summary);
        } catch (aiErr) {
            console.error("AI Summary failed, but moving forward:", aiErr.message);
        }

        await db.collection("jobs").insertOne({
            title: title,
            description: description,
            location: location || "Remote",
            salary: salary || "Competitive",
            aiSummary: summary, 
            createdAt: new Date()
        });

        res.redirect('/admin');
    } catch (err) {
        console.error("Critical Job Post Error:", err);
        res.status(500).send("Failed to create job: " + err.message);
    } // <--- This was likely where the bracket went missing!
});

app.get('/job/:id', async (req, res) => {
    try {
        const db = client.db("hirelens");
        const job = await db.collection("jobs").findOne({ _id: new ObjectId(req.params.id) });
        
        if (!job) return res.status(404).send("Job not found");
        
        res.render('job-detail', { job });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Add/Check this in server.js
app.post('/admin/status/:id', async (req, res) => {
    try {
        const { status } = req.body;
        const db = client.db("hirelens");
        
        await db.collection("candidates").updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: status } }
        );
        
        console.log(`✅ Status updated to ${status} for ${req.params.id}`);
        res.sendStatus(200);
    } catch (err) {
        console.error("❌ Status Update Failed:", err);
        res.status(500).send(err.message);
    }
});
// 🗑️ Delete a Candidate
app.delete('/admin/candidate/:id', checkAuth, async (req, res) => {
    try {
        const db = client.db("hirelens");
        await db.collection("candidates").deleteOne({ _id: new ObjectId(req.params.id) });
        res.sendStatus(200);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 🗑️ Delete a Job
app.delete('/admin/job/:id', checkAuth, async (req, res) => {
    try {
        const db = client.db("hirelens");
        // Warning: This deletes the job, but candidates will remain (with an "Unknown Job" title)
        await db.collection("jobs").deleteOne({ _id: new ObjectId(req.params.id) });
        res.sendStatus(200);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.post('/admin/bulk-delete', checkAuth, async (req, res) => {
    try {
        const { ids } = req.body;
        const db = client.db("hirelens");
        const objectIds = ids.map(id => new ObjectId(id));

        // 1. Find all selected candidates to get their S3 keys
        const candidatesToDelete = await db.collection("candidates")
            .find({ _id: { $in: objectIds } }).toArray();

        // 2. Loop through and delete from S3
        for (const candidate of candidatesToDelete) {
            if (candidate.resumeUrl) {
                try {
                    const s3Key = candidate.resumeUrl.split('.com/')[1];
                    await s3.send(new DeleteObjectCommand({
                        Bucket: "hirelens-resumes-storage-012838204573-us-west-2-an",
                        Key: s3Key
                    }));
                    console.log(`🗑️ S3 File Deleted: ${s3Key}`);
                } catch (s3Err) {
                    console.error("S3 Delete Warning:", s3Err.message);
                }
            }
        }

        // 3. Delete from MongoDB
        const result = await db.collection("candidates").deleteMany({ _id: { $in: objectIds } });
        
        console.log(`✅ Bulk Delete Successful: ${result.deletedCount} records removed.`);
        res.sendStatus(200);

    } catch (err) {
        console.error("❌ Bulk Delete Error:", err);
        res.status(500).send(err.message);
    }
});


app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    
    const { username, password } = req.body;

    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        console.log("✅ Success! Redirecting...");
        req.session.isAdmin = true;
        res.redirect('/admin');
    } else {
        console.log("❌ Failed: Credentials did not match.");
        res.send('Invalid credentials. <a href="/login">Try again</a>');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`🚀 HireLens V1 is running at http://localhost:${PORT}`);
});
module.exports = app;