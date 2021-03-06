const express = require('express');
const router = express.Router();
const session = require('express-session');
const uuid = require('uuid');
const request = require('request');
const fs = require('fs');
const csvParse = require('csv-parse');
const async = require('async');

const twilio = require('twilio');

const redis = require("redis");
const client = redis.createClient();

client.on("error", function (err) {
    console.log("Error " + err);
});

router.get('/', function(req, res, next) {
  res.send('WILDTRACK');
});

/* GET home page. */
router.get('/incidents', function(req, res, next) {
  client.keys("incident_*", function(err, reply) {
    if (reply) {
      let r = [];
      let total = reply.length;
      reply.forEach(function(e) {
        client.hgetall(e, function(err, reply) {
          r.push(reply);
          if (r.length == total) {
            res.json(r);
          }
        });
      });
    } else {
      res.json(null);
    }
  });
});

function detectLanguage(text) {
  var options = {
    url: 'https://westus.api.cognitive.microsoft.com/text/analytics/v2.0/languages',
    headers: {
      'Ocp-Apim-Subscription-Key': '128fa6ebe0e749cca983096e5ca61930'
    },
    method: "POST",
    json: {
      "documents" : [ {
        "id":"1",
        "text":text
      }]
    }
  };

  function callback(error, response, body) {
    if (!error && response.statusCode == 200) {
      return body.documents[0].detectedLanguages[0].name
    } else {
      console.error(body);
    }
  }

  request(options, callback);
}

function createOrUpdateIncident(req, data) {
  let profileId = "profile_"+req.body.From;
  client.hgetall(profileId, function(err, reply) {
    if (reply) {
      // TODO
    } else {
      const profile = {
        country: req.body.FromCountry,
        state: req.body.FromState,
        city: req.body.FromCity
      }
      client.hmset(profileId, profile);
    }
  });

  let incidentId = "incident_"+req.body.From+"_"+req.session.identifier;
  client.hgetall(incidentId, function(err, reply) {
    if (reply) {
      const incident = {
        id: incidentId,
        longitude: data.longitude,
        latitude: data.latitude,
        humanActivity: reply.humanActivity ? reply.humanActivity+data.humanActivity : data.humanActivity,
        animals: reply.animals ? reply.animals+data.animals : data.animals,
        language: data.language
      };
      client.hmset(incidentId, incident, redis.print);
    } else {
      const incident = {
        id: incidentId,
        timestamp: Date.now(),
        longitude: data.longitude,
        latitude: data.latitude,
        humanActivity: data.humanActivity,
        animals: data.animals,
        language:data.language
      };
      client.hmset(incidentId, incident, redis.print);
    }
  });
}

function determineConversationState(req) {
  let stateWhat = req.session.stateWhat || 0;
  let stateWhere = req.session.stateWhere || 0;
  let statePhotoNeeded = req.session.statePhotoNeeded || 0;
  let stateAnon = req.session.stateAnon || 0;

  console.log(stateWhat+"-"+stateWhere+"-"+statePhotoNeeded+"-"+stateAnon);

  const localization = {
    "stateWhat": {
      "English" : "What do you see?",
      "Swahili" : "Unaona nini?"
    },
    "stateWhere": {
      "English" : "Please describe the exact location or send GPS Coordinates",
      "Swahili" : "Kuelezea eneo halisi au kutuma GPS kuratibu"
    },
    "statePhotoNeeded": {
      "English" : "Can you please send a photo over MMS?",
      "Swahili" : "Je, unaweza tafadhali tuma picha zaidi MMS?"
    },
    "stateAnon": {
      "English": "Thank you! Your report is anonymous unless you reply YES to join the rewards program",
      "Swahili": "Asante! ripoti yako ni bila majina isipokuwa wewe kujibu NDIYO kwa kujiunga na mpango tuzo"
    },
    "stateAnonNo": {
      "English": "Welcome to the rewards program!",
      "Swahili": "Karibu mpango tuzo!"
    },
    "done": {
      "English": "Incident reported.",
      "Swahili": "ripoti kukamilika"
    }
  };

  if (stateWhat == 0) {
    stateWhat = 1;
    messageStr = localization["stateWhat"][(req.session.language)];
  } else if (stateWhere == 0) {
    stateWhere = 1;
    messageStr = localization["stateWhere"][(req.session.language)];
  } else if (statePhotoNeeded == 0) {
    statePhotoNeeded = 1;
    messageStr = localization["statePhotoNeeded"][(req.session.language)];
  } else if (stateAnon == 0) {
    stateAnon = 1;
    messageStr = localization["stateAnon"][(req.session.language)];
  } else {
    if (stateAnon == 1 && req.body.Body === "YES") {
      messageStr = localization["stateAnonNo"][(req.session.language)];
    } else {
      messageStr = localization["done"][(req.session.language)];
    }
  }
  console.log("messageStr: "+messageStr);
  return {
    "stateWhat" : stateWhat,
    "stateWhere" : stateWhere,
    "statePhotoNeeded" : statePhotoNeeded,
    "stateAnon" : stateAnon,
    message: messageStr
  }
}

function checkForLocationStopword(req) {
  let content = fs.readFileSync('./locations.csv');
  let csvParser = new csvParse.Parser({delimiter: ','});
  csvParser.write(content, true);
  let chunk;
  let r = {
    latitude:"",
    longitude:""
  };
  while(chunk = csvParser.read()){
    if (req.body.Body.toLowerCase().includes(chunk[0].toLowerCase())) {
      console.log(chunk[0]);
        r = {
          latitude:chunk[1],
          longitude:chunk[2]
        };
    }
  }
  return r;
}

function checkForHumanActivityStopword(req) {
  let content = fs.readFileSync('./human-activities.csv');
  let csvParser = new csvParse.Parser({delimiter: ','});
  csvParser.write(content, true);
  let chunk;
  let r = "";
  while(chunk = csvParser.read()){
    let stopword = chunk[1];
    if (req.session.language !== "English") {
      stopword = chunk[2];
    }
    if (stopword.length > 0 &&
      req.body.Body.toLowerCase().includes(stopword.toLowerCase())) {
        r += chunk[0] + ", ";
    }
  }
  return r;
}

function checkForAnimalStopword(req) {
  let content = fs.readFileSync('./animals.csv');
  let csvParser = new csvParse.Parser({delimiter: ','});
  csvParser.write(content, true);
  let chunk;
  let r = "";
  while(chunk = csvParser.read()){
    let stopword = chunk[1];
    if (req.session.language !== "English") {
      stopword = chunk[2];
    }
    if (stopword.length > 0 &&
      req.body.Body.toLowerCase().includes(stopword.toLowerCase())) {
        r += chunk[0] + ", ";
        console.log(r);
    }
  }
  return r;
}

router.post('/sms', function(req, res, next) {
  console.log(req.body);
  console.log(req.session);

  const twiml = new twilio.TwimlResponse();
  let sessionIdentifier = req.session.identifier || uuid.v4();

  const minute = 180000;
  req.session.cookie.expires = new Date(Date.now() + minute);
  req.session.cookie.maxAge = minute;
  req.session.identifier = sessionIdentifier;

  if (parseInt(req.body.NumMedia) > 0) {
    req.session.statePhotoNeeded = 1;
  }

  // determine language
  let language = "English";

  if (req.session.language == null && req.body.Body.length >= 2) {
    var options = {
      url: 'https://westus.api.cognitive.microsoft.com/text/analytics/v2.0/languages',
      headers: {
        'Ocp-Apim-Subscription-Key': '128fa6ebe0e749cca983096e5ca61930'
      },
      method: "POST",
      json: {
        "documents" : [{
          "id":"1",
          "text":req.body.Body
        }]
      }
    };

    function callback(error, response, body) {
      if (!error && response.statusCode == 200) {
        language = body.documents[0].detectedLanguages[0].name;
        req.session.language = language;

        const s = determineConversationState(req);
        let message = s.message;
        req.session.stateWhat = s.stateWhat;
        req.session.stateWhere = s.stateWhere;
        req.session.statePhotoNeeded = s.statePhotoNeeded;
        req.session.stateAnon = s.stateAnon;

        const location = checkForLocationStopword(req);
        const humanActivity = checkForHumanActivityStopword(req);
        const animals = checkForAnimalStopword(req);

        createOrUpdateIncident(req, {
          longitude: location.longitude,
          latitude: location.latitude,
          humanActivity: humanActivity,
          animals: animals,
          language: language
        });

        if (message.length >= 2) {
          twiml.message(message);
          res.writeHead(200, {'Content-Type': 'text/xml'});
          res.end(twiml.toString());
        }
      } else {
        console.error(body);
      }
    }
    request(options, callback);
  } else {
    language = req.session.language;

    const s = determineConversationState(req);
    let message = s.message;
    req.session.stateWhat = s.stateWhat;
    req.session.stateWhere = s.stateWhere;
    req.session.statePhotoNeeded = s.statePhotoNeeded;
    req.session.stateAnon = s.stateAnon;

    const location = checkForLocationStopword(req);
    const humanActivity = checkForHumanActivityStopword(req);
    const animals = checkForAnimalStopword(req);

    createOrUpdateIncident(req, {
      longitude: location.longitude,
      latitude: location.latitude,
      humanActivity: humanActivity,
      animals: animals,
      language: language
    });

    if (message.length >= 2) {
      twiml.message(message);
      res.writeHead(200, {'Content-Type': 'text/xml'});
      res.end(twiml.toString());
    }
  }
});

module.exports = router;
